import { Global } from "@codeworksh/harness/effect";
import { Door, Forwarded, Pairing as Wire } from "@codeworksh/schema";
import { NodeServices } from "@effect/platform-node";
import { Clock, Context, Duration, Effect, FileSystem, Layer, Path, Semaphore, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as IpNetwork from "effect/net/IpNetwork";
import * as Private from "../framework/private.ts";
import type { DeviceInfo } from "./contract.ts";

/**
 * How another computer becomes a device of this machine. A person reads it a pairing code from
 * `codework service pair`, which it exchanges at `POST /api/v1/devices` for a session token of its own. It then
 * takes a ticket at `POST /api/v1/tickets` for each socket it opens, offering the ticket where a local client
 * offers the home's token. Codes and tickets live in memory; devices persist in `<home>/devices.json`,
 * which holds a hash of each session token, never the token, and whether the device's last request
 * came over TLS.
 */

const codeLife = Duration.toMillis("10 minutes");
const ticketLife = Duration.toMillis("60 seconds");
/** How long a session may go without taking a ticket before it is refused. */
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

const hash = (token: string) =>
	Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).pipe(
		Effect.map((digest) => Base64Url.encode(new Uint8Array(digest))),
	);

const Device = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	/** SHA-256 of the session token, base64url. */
	hash: Schema.String,
	createdAt: Schema.Finite,
	seenAt: Schema.Finite,
	encrypted: Schema.optional(Schema.Boolean),
});
type Device = typeof Device.Type;

const devicesJson = Schema.fromJsonString(Schema.Array(Device));

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
		/** A fresh pairing code, `XXXXX-XXXXX`. */
		readonly code: Effect.Effect<{ readonly code: string; readonly expiresAt: number }>;
		/** A new device for a live code, which is spent; none for any other code. */
		readonly exchange: (
			code: string,
			label: string,
			encrypted: boolean,
		) => Effect.Effect<{ readonly id: string; readonly token: string } | undefined>;
		/** A ticket for the device holding `token`; none for an unknown, revoked or idle session. */
		readonly ticket: (token: string, encrypted: boolean) => Effect.Effect<string | undefined>;
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
		const path = file((yield* Global.Service).home);
		let devices: ReadonlyArray<Device> = (yield* fs.exists(path))
			? yield* fs.readFileString(path).pipe(
					Effect.flatMap(Schema.decodeEffect(devicesJson)),
					Effect.catch(() => Effect.die(`${path} is not a valid devices file`)),
				)
			: [];
		const codes = passes<true>();
		const tickets = passes<string>();
		// One write at a time, each from the list the last one left.
		const lock = yield* Semaphore.make(1);
		const save = (next: ReadonlyArray<Device>) =>
			Effect.gen(function* () {
				yield* Private.write(path, yield* Schema.encodeEffect(devicesJson)(next));
				devices = next;
			}).pipe(Effect.provideContext(files), Effect.orDie);

		return Service.of({
			code: Effect.gen(function* () {
				const code = yield* random(10);
				const expiresAt = (yield* Clock.currentTimeMillis) + codeLife;
				codes.issue(code, expiresAt, true);
				return { code: `${code.slice(0, 5)}-${code.slice(5)}`, expiresAt };
			}),
			exchange: (code, label, encrypted) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					if (codes.take(normalize(code), now) === undefined) return undefined;
					const token = yield* Door.make;
					const device: Device = {
						id: `dev_${(yield* random(10)).toLowerCase()}`,
						label,
						hash: yield* hash(token),
						createdAt: now,
						seenAt: now,
						encrypted,
					};
					yield* lock.withPermit(Effect.suspend(() => save([...devices, device])));
					return { id: device.id, token };
				}),
			ticket: (token, encrypted) =>
				Effect.gen(function* () {
					const digest = yield* hash(token);
					return yield* lock.withPermit(
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							const device = devices.find((device) => Door.matches(digest, device.hash));
							if (device === undefined || now - device.seenAt > idleLife) return undefined;
							yield* save(
								devices.map((each) => (each === device ? { ...device, seenAt: now, encrypted } : each)),
							);
							const ticket = yield* Door.make;
							tickets.issue(ticket, now + ticketLife, device.id);
							return ticket;
						}),
					);
				}),
			redeem: (ticket) =>
				Effect.map(Clock.currentTimeMillis, (now) => {
					const id = tickets.take(ticket, now);
					return devices.some((device) => device.id === id) ? id : undefined;
				}),
			list: Effect.sync(() =>
				devices.map(({ id, label, createdAt, seenAt, encrypted }) => ({
					id,
					label,
					createdAt,
					seenAt,
					...(encrypted === undefined ? {} : { encrypted }),
				})),
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

const bearer = (header: string | undefined) => /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "")?.[1];

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
				const token = bearer(request.headers.authorization);
				const ticket =
					token === undefined ? undefined : yield* pairing.ticket(token, Forwarded.encrypted(request, trusted));
				return ticket === undefined ? refused : HttpServerResponse.jsonUnsafe({ ticket }, { status: 201 });
			}),
		);
	}),
);
