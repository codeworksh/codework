import { Global } from "@codeworksh/harness/effect";
import { Door, Forwarded, Jws, Pairing as Wire } from "@codeworksh/schema";
import { NodeServices } from "@effect/platform-node";
import { Clock, Context, Duration, Effect, FileSystem, Layer, Option, Path, Semaphore, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as IpNetwork from "effect/net/IpNetwork";
import * as Private from "../framework/private.ts";
import * as MachineFile from "../machine/file.ts";
import type { DeviceInfo } from "./contract.ts";

/**
 * How another computer becomes a device of this machine, as a key pairs over SSH. A person reads it a
 * pairing code from `codework service pair`, which it exchanges at `POST /api/v1/devices` with its public
 * key, and gets back this machine's identity key. For each socket it opens it then signs a proof with its
 * key at `POST /api/v1/tickets`, and gets back a ticket signed with the identity key, which it offers where
 * a local client offers the home's token. Codes, tickets and spent nonces live in memory; devices persist in
 * `<home>/devices.json`: each one's public key, and whether its last request came over TLS.
 */

const codeLife = Duration.toMillis("10 minutes");
const ticketLife = Duration.toMillis("60 seconds");
/** How long a device may go without taking a ticket before it is refused. */
const idleLife = Duration.toMillis("30 days");

/** Crockford's base32: no I, L, O or U, so a code read aloud is typed back right. */
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `length` random base32 characters, each from a byte's low 5 bits, so each is uniform. */
const random = (length: number) =>
	Effect.sync(() =>
		Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => alphabet.charAt(byte & 31)).join(""),
	);

/** A code as a person may type it back: any case, with or without its dash, I and L for 1, O for 0. */
const normalize = (code: string) => code.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");

const Device = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	key: Jws.PublicKey,
	createdAt: Schema.Finite,
	seenAt: Schema.Finite,
	encrypted: Schema.optional(Schema.Boolean),
});
type Device = typeof Device.Type;

const devicesJson = Schema.fromJsonString(Schema.Array(Device));
const isDevice = Schema.is(Device);
const decodeProof = Schema.decodeUnknownEffect(Wire.Proof);
/** The nonce a refusal echoes, read from a proof it never trusts, so only one a proof could carry. */
const decodeNonce = Schema.decodeUnknownEffect(
	Schema.Struct({ nonce: Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^[A-Za-z0-9_-]+$/)) }),
);

/** `<home>/devices.json`: written by its server alone. */
export const file = (home: string) => `${home}/devices.json`;

/** One-time secrets held until used or expired; each is taken at most once. */
const passes = <A>() => {
	let held: ReadonlyArray<{ readonly secret: string; readonly expiresAt: number; readonly value: A }> = [];
	return {
		issue: (secret: string, expiresAt: number, value: A) => {
			held = [...held, { secret, expiresAt, value }];
		},
		take: (given: string, now: number) => {
			held = held.filter((pass) => pass.expiresAt > now);
			const found = held.find((pass) => Door.matches(given, pass.secret));
			held = held.filter((pass) => pass !== found);
			return found?.value;
		},
		drop: (value: A) => {
			held = held.filter((pass) => pass.value !== value);
		},
	};
};

export class Service extends Context.Service<
	Service,
	{
		/** A fresh pairing code, `XXXXX-XXXXX`, and the fingerprint of the key the device will keep. */
		readonly code: Effect.Effect<{ readonly code: string; readonly expiresAt: number; readonly fingerprint: string }>;
		/** A new device holding `key` for a live code, which is spent, and the identity key; none for any other code. */
		readonly exchange: (
			code: string,
			label: string,
			key: Jws.PublicKey,
			encrypted: boolean,
		) => Effect.Effect<typeof Wire.Device.Type | undefined>;
		/**
		 * A signed {@link Wire.Grant} for a good proof. Any other, or an unknown, revoked or idle device, is
		 * refused: with a signed {@link Wire.Refusal} when the proof names a nonce, else with nothing.
		 */
		readonly ticket: (
			proof: string,
			encrypted: boolean,
		) => Effect.Effect<
			{ readonly _tag: "Granted"; readonly jws: string } | { readonly _tag: "Refused"; readonly jws?: string }
		>;
		/** The device a live ticket was issued to, spending it; none otherwise. */
		readonly redeem: (ticket: string) => Effect.Effect<string | undefined>;
		readonly list: Effect.Effect<ReadonlyArray<DeviceInfo>>;
		/** Forgets a device and its tickets; false when none has `id`. */
		readonly revoke: (id: string) => Effect.Effect<boolean>;
	}
>()("@codeworksh/cli/server/pairing/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
		const home = (yield* Global.Service).home;
		const path = file(home);
		const stored: ReadonlyArray<unknown> = (yield* fs.exists(path))
			? yield* fs.readFileString(path).pipe(
					Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)))),
					Effect.catch(() => Effect.die(`${path} is not a valid devices file`)),
				)
			: [];
		// A device paired before devices held keys pairs again; the next write drops it.
		let devices: ReadonlyArray<Device> = stored.filter(isDevice);
		if (devices.length < stored.length)
			yield* Effect.logWarning(`${path}: ${stored.length - devices.length} device(s) must pair again`);
		const codes = passes<true>();
		const tickets = passes<string>();
		/** Each proof's nonce, until its proof is past the window. */
		const nonces = new Map<string, number>();
		// One write at a time, each from the list the last one left.
		const lock = yield* Semaphore.make(1);
		const save = (next: ReadonlyArray<Device>) =>
			Effect.gen(function* () {
				yield* Private.write(path, yield* Schema.encodeEffect(devicesJson)(next));
				devices = next;
			}).pipe(Effect.provideContext(files), Effect.orDie);
		const identity = MachineFile.identity(home).pipe(Effect.provideContext(files), Effect.orDie);
		const fingerprint = (key: Jws.PublicKey) => Jws.fingerprint(key).pipe(Effect.orDie);

		/**
		 * The device a proof is good for, by id: signed by the key of the device it names, inside the window,
		 * its nonce unseen and now spent. Checked outside the lock, so a flood of bad proofs holds up no write.
		 */
		const proven = Effect.fnUntraced(
			function* (proof: string, now: number) {
				const { kid } = yield* Jws.peek(proof);
				const holders = yield* Effect.filter(devices, (device) =>
					Effect.map(Jws.thumbprint(device.key), (thumbprint) => thumbprint === kid),
				);
				const [holder] = holders;
				if (holder === undefined) return undefined;
				const claims = yield* Jws.verify(proof, holder.key).pipe(Effect.flatMap(decodeProof));
				const device = holders.find((each) => each.id === claims.device);
				if (device === undefined || claims.aud !== (yield* identity).keyId) return undefined;
				if (Math.abs(now - claims.iat) > Wire.proofWindow) return undefined;
				for (const [nonce, until] of nonces) if (until < now) nonces.delete(nonce);
				if (nonces.has(claims.nonce)) return undefined;
				// Held in memory only: a proof taken in the window before a restart is good once more after it.
				nonces.set(claims.nonce, claims.iat + Wire.proofWindow);
				return { id: device.id, nonce: claims.nonce };
			},
			Effect.orElseSucceed(() => undefined),
		);

		return Service.of({
			code: Effect.gen(function* () {
				const code = yield* random(10);
				const expiresAt = (yield* Clock.currentTimeMillis) + codeLife;
				const key = Jws.publicOf((yield* identity).key);
				codes.issue(code, expiresAt, true);
				return { code: `${code.slice(0, 5)}-${code.slice(5)}`, expiresAt, fingerprint: yield* fingerprint(key) };
			}),
			exchange: (code, label, key, encrypted) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					if (codes.take(normalize(code), now) === undefined) return undefined;
					const machine = Jws.publicOf((yield* identity).key);
					const device: Device = {
						id: `dev_${(yield* random(10)).toLowerCase()}`,
						label,
						key,
						createdAt: now,
						seenAt: now,
						encrypted,
					};
					yield* lock.withPermit(Effect.suspend(() => save([...devices, device])));
					return { id: device.id, machine };
				}),
			ticket: (proof, encrypted) =>
				Effect.gen(function* () {
					const refuse = Effect.gen(function* () {
						const echoed = yield* Jws.peekClaims(proof).pipe(Effect.flatMap(decodeNonce), Effect.option);
						if (Option.isNone(echoed)) return { _tag: "Refused" } as const;
						const { key, keyId } = yield* identity;
						const refusal: Wire.Refusal = {
							op: "ticket.refuse",
							nonce: echoed.value.nonce,
							at: yield* Clock.currentTimeMillis,
						};
						return {
							_tag: "Refused",
							jws: yield* Jws.sign(refusal, key, { kid: keyId }).pipe(Effect.orDie),
						} as const;
					});
					const proved = yield* proven(proof, yield* Clock.currentTimeMillis);
					if (proved === undefined) return yield* refuse;
					const ticket = yield* lock.withPermit(
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							// Found again: it may have been revoked since its proof was checked.
							const device = devices.find((each) => each.id === proved.id);
							if (device === undefined || now - device.seenAt > idleLife) return undefined;
							yield* save(
								devices.map((each) => (each === device ? { ...device, seenAt: now, encrypted } : each)),
							);
							const ticket = yield* Door.make;
							tickets.issue(ticket, now + ticketLife, device.id);
							return ticket;
						}),
					);
					if (ticket === undefined) return yield* refuse;
					const { key, keyId } = yield* identity;
					const grant: Wire.Grant = { op: "ticket.grant", ticket, nonce: proved.nonce };
					return { _tag: "Granted", jws: yield* Jws.sign(grant, key, { kid: keyId }).pipe(Effect.orDie) } as const;
				}),
			redeem: (ticket) =>
				Effect.map(Clock.currentTimeMillis, (now) => {
					const id = tickets.take(ticket, now);
					return devices.some((device) => device.id === id) ? id : undefined;
				}),
			list: Effect.suspend(() =>
				Effect.forEach(devices, ({ id, label, key, createdAt, seenAt, encrypted }) =>
					Effect.map(fingerprint(key), (fingerprint) => ({
						id,
						label,
						fingerprint,
						createdAt,
						seenAt,
						...(encrypted === undefined ? {} : { encrypted }),
					})),
				),
			),
			revoke: (id) =>
				lock.withPermit(
					Effect.gen(function* () {
						if (!devices.some((device) => device.id === id)) return false;
						yield* save(devices.filter((device) => device.id !== id));
						tickets.drop(id);
						return true;
					}),
				),
		});
	}),
).pipe(Layer.provide(NodeServices.layer));

const refused = HttpServerResponse.empty({ status: 401 });

/** The peers besides loopback whose `X-Forwarded-Proto` the pairing routes believe. */
export const TrustedProxy = Context.Reference<ReadonlyArray<IpNetwork.IpNetwork>>(
	"@codeworksh/cli/server/pairing/TrustedProxy",
	{ defaultValue: () => [] },
);

/** The routes {@link routes} serves, which take no socket credential. */
export const paths: ReadonlyArray<string> = [Wire.devicesPath, Wire.ticketsPath];

/** The pairing routes of the shared wire contract. */
export const routes = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const pairing = yield* Service;
		const trusted = yield* TrustedProxy;
		yield* router.add(
			"POST",
			Wire.devicesPath,
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const body = yield* HttpServerRequest.schemaBodyJson(Wire.Exchange).pipe(Effect.option);
				if (body._tag === "None") return HttpServerResponse.empty({ status: 400 });
				const device = yield* pairing.exchange(
					body.value.code,
					body.value.label,
					body.value.key,
					Forwarded.encrypted(request, trusted),
				);
				return device === undefined ? refused : HttpServerResponse.jsonUnsafe(device, { status: 201 });
			}),
		);
		yield* router.add(
			"POST",
			Wire.ticketsPath,
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const body = yield* HttpServerRequest.schemaBodyJson(Wire.Signed).pipe(Effect.option);
				if (Option.isNone(body)) return refused;
				const answer = yield* pairing.ticket(body.value.jws, Forwarded.encrypted(request, trusted));
				if (answer.jws === undefined) return refused;
				return HttpServerResponse.jsonUnsafe(
					{ jws: answer.jws },
					{ status: answer._tag === "Granted" ? 201 : 401 },
				);
			}),
		);
	}),
);
