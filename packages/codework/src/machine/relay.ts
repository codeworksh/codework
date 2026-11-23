import { NodeServices } from "@effect/platform-node";
import { Jws, Machine, Relay } from "@codeworksh/schema";
import { Clock, Config, Context, Duration, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { uuidv7 } from "uuidv7";
import pkg from "../../package.json" with { type: "json" };
import { hostName } from "../server/identity.ts";
import * as File from "./file.ts";

/** The relay's typed client at `url`. */
const at = (url: string) => HttpApiClient.make(Relay.Api, { baseUrl: url }).pipe(Effect.provide(FetchHttpClient.layer));

/**
 * The relay new connects go to: `CODEWORK_RELAY_URL`, default https://relay.codework.sh. A link keeps
 * talking to the relay it was made with, whatever this says later.
 */
export class Client extends Context.Service<
	Client,
	{ readonly url: string; readonly api: HttpApiClient.ForApi<typeof Relay.Api> }
>()("@codeworksh/cli/machine/relay/Client") {
	static readonly layer = Layer.effect(
		Client,
		Effect.gen(function* () {
			const url = yield* Config.String("CODEWORK_RELAY_URL").pipe(Config.withDefault("https://relay.codework.sh"));
			return { url, api: yield* at(url) };
		}),
	);
}

/** What this machine says about itself to the relay. */
const describe = Effect.fn("Machine.describe")(function* (machine: File.Machine) {
	const localHostName = yield* hostName.pipe(Effect.provide(NodeServices.layer));
	return {
		id: machine.id,
		source: machine.source,
		localHostName,
		givenName: machine.givenName ?? null,
		os: process.platform,
		arch: process.arch,
		version: pkg.version,
	} satisfies Relay.MachineInfo;
});

/** This machine and its workspaces, as the desktop app shows them. */
export const status = Effect.fn("Machine.status")(function* (home: string) {
	const stored = yield* File.read(home);
	const localHostName = yield* hostName.pipe(Effect.provide(NodeServices.layer));
	if (stored._tag === "None")
		return { id: null, localHostName, givenName: null, workspaces: [] } satisfies Machine.Status;
	const machine = stored.value;
	return {
		id: machine.id,
		localHostName,
		givenName: machine.givenName ?? null,
		workspaces: Object.entries(machine.workspaces).map(([id, link]) => ({
			id,
			name: link.name,
			keyId: link.keyId,
			leaving: link.leaving === true,
		})),
	} satisfies Machine.Status;
});

/**
 * Names this machine for people: empty clears the name back to the OS's. The relay hears it on the
 * next heartbeat.
 */
export const rename = Effect.fn("Machine.rename")(function* (home: string, givenName: string) {
	const name = givenName.trim();
	yield* File.update(home, {}, ({ givenName: _previous, ...machine }) =>
		Effect.succeed(name === "" ? machine : { ...machine, givenName: name }),
	);
	return yield* status(home);
});

/**
 * Pairs this home with a workspace: registers a fresh key with the relay, shows the code a member
 * approves, and polls with that key until the relay links it, then saves the link. Each workspace gets
 * its own key, and only this process can take the link: a connect that stops is never linked.
 */
export const connect = Effect.fn("Machine.connect")(function* (options: {
	readonly home: string;
	readonly workspaceId?: string | undefined;
	readonly machineId?: string | undefined;
	readonly onCode: (userCode: string) => Effect.Effect<void>;
}) {
	const client = yield* Client;
	yield* File.checkId(options.machineId);
	const machine = yield* File.update(options.home, { machineId: options.machineId }, Effect.succeed);
	const key = yield* Jws.generate();
	const keyId = yield* Jws.thumbprint(Jws.publicOf(key));
	const iat = yield* Clock.currentTimeMillis;
	const binding: Relay.IdentityClaims = { op: "identity.bind", iat, keyId };
	const claims: Relay.PairingClaims = {
		op: "pairing.create",
		iat,
		machine: yield* describe(machine),
		workspaceId: options.workspaceId ?? null,
		identity: yield* Jws.sign(binding, machine.identity.key, { embed: true }),
	};
	const pairing = yield* client.api.machine
		.pair({ payload: { jws: yield* Jws.sign(claims, key, { embed: true }) } })
		.pipe(
			Effect.catchTag("Relay.NotFound", () =>
				Effect.fail(new Machine.ConnectError({ message: "No such workspace" })),
			),
		);
	yield* options.onCode(pairing.userCode);

	const poll = Effect.gen(function* () {
		const claims: Relay.PollClaims = { op: "pairing.poll", iat: yield* Clock.currentTimeMillis };
		return yield* client.api.machine.poll({ payload: { jws: yield* Jws.sign(claims, key, { kid: keyId }) } });
	}).pipe(
		// A dropped request or a relay restart doesn't end the connect; the next poll asks again.
		Effect.catchTag("HttpClientError", (error) =>
			Effect.logDebug("Pairing poll failed", error).pipe(Effect.as(undefined)),
		),
	);
	let previous = machine;
	const deadline = (yield* Clock.currentTimeMillis) + pairing.expiresIn * 1000;
	while ((yield* Clock.currentTimeMillis) < deadline) {
		yield* Effect.sleep(Duration.seconds(pairing.interval));
		const status = yield* poll;
		if (status === undefined) continue;
		if (status.status !== "approved") {
			if (status.status === "pending") continue;
			if (status.status === "expired") break;
			return yield* new Machine.ConnectError({
				message:
					status.status === "declined"
						? "The connect was declined; run connect again for a new code"
						: "Another connect for this machine finished first",
			});
		}
		const { connected } = status;
		// A poll response can arrive after another connect saved a different key.
		// Observe that change under the lock, then poll again before replacing it.
		const id = connected.workspace.id;
		const stored = yield* File.update(options.home, {}, (current) =>
			Effect.succeed(
				current.workspaces[id]?.keyId !== previous.workspaces[id]?.keyId
					? current
					: {
							...current,
							workspaces: {
								...current.workspaces,
								[connected.workspace.id]: {
									name: connected.workspace.name,
									owner: connected.owner,
									relay: client.url,
									key,
									keyId,
								},
							},
						},
			),
		);
		if (stored.workspaces[id]?.keyId === keyId) return connected;
		previous = stored;
	}
	return yield* new Machine.ConnectError({ message: "The code expired before it was approved; run connect again" });
});

/**
 * Asks the link's relay to revoke it, signed with its own key: true once the relay confirms, or says it
 * was revoked already; false when it can't be reached in time.
 */
const revoke = (machineId: string, workspaceId: string, link: File.Machine["workspaces"][string]) =>
	Effect.gen(function* () {
		const claims: Relay.RevokeClaims = {
			op: "machine.revoke",
			iat: yield* Clock.currentTimeMillis,
			jti: uuidv7(),
			workspaceId,
			machineId,
		};
		const api = yield* at(link.relay);
		yield* api.machine.revoke({ payload: { jws: yield* Jws.sign(claims, link.key, { kid: link.keyId }) } });
	}).pipe(
		// Leave time for the local update before the desktop RPC expires.
		Effect.timeout("3 seconds"),
		Effect.as(true),
		Effect.catchTag("Relay.MachineRevoked", () => Effect.succeed(true)),
		Effect.catch((error) => Effect.logDebug(`Revoke at ${link.name} failed`, error).pipe(Effect.as(false))),
	);

/**
 * One heartbeat per connected workspace, each to the relay its link was made with, all at once. A link
 * the relay refuses as revoked is removed, but only while it still holds the refused key. A leaving link
 * asks for its revoke again instead, and is removed once the relay confirms.
 */
export const heartbeat = Effect.fn("Machine.heartbeat")(function* (home: string) {
	const stored = yield* File.read(home);
	if (stored._tag === "None") return;
	const machine = stored.value;
	const info = yield* describe(machine);
	yield* Effect.forEach(
		Object.entries(machine.workspaces),
		([workspaceId, link]) =>
			link.leaving === true
				? revoke(machine.id, workspaceId, link).pipe(
						Effect.flatMap((revoked) =>
							revoked ? File.removeLink(home, workspaceId, link.keyId).pipe(Effect.asVoid) : Effect.void,
						),
						Effect.catch((error) => Effect.logDebug(`Leaving ${link.name} failed`, error)),
					)
				: Effect.gen(function* () {
						const api = yield* at(link.relay);
						const claims: Relay.HeartbeatClaims = {
							op: "machine.heartbeat",
							iat: yield* Clock.currentTimeMillis,
							workspaceId,
							machine: info,
						};
						yield* api.machine.heartbeat({
							payload: { jws: yield* Jws.sign(claims, link.key, { kid: link.keyId }) },
						});
					}).pipe(
						Effect.timeout("10 seconds"),
						Effect.catchTags({
							"Relay.MachineRevoked": (revoked) =>
								Effect.logWarning(`Disconnected from ${link.name}: ${revoked.message}`).pipe(
									Effect.andThen(File.removeLink(home, workspaceId, link.keyId)),
								),
							// Refused but not revoked, most often a clock more than a minute off: worth seeing in the log.
							"Relay.Unauthorized": (refused) =>
								Effect.logWarning(`Heartbeat to ${link.name} refused: ${refused.message}`),
						}),
						Effect.catch((error) => Effect.logDebug(`Heartbeat to ${link.name} failed`, error)),
					),
		{ concurrency: "unbounded", discard: true },
	);
});

/**
 * Leaves a workspace: asks the link's relay to revoke it, then forgets it locally. When the relay can't
 * confirm, the link is kept as leaving, with its key, and each heartbeat asks again until it does; the
 * relay still lists it until then. `revoked` says whether it confirmed now.
 */
export const disconnect = Effect.fn("Machine.disconnect")(function* (
	home: string,
	workspaceId: string,
	expectedKeyId?: string,
) {
	const stored = yield* File.read(home);
	const link = stored._tag === "Some" ? stored.value.workspaces[workspaceId] : undefined;
	if (stored._tag === "None" || link === undefined) {
		return yield* new Machine.ConnectError({ message: `This machine is not connected to workspace ${workspaceId}` });
	}
	if (expectedKeyId !== undefined && link.keyId !== expectedKeyId)
		return yield* new Machine.ConnectError({ message: "This machine link has changed" });
	const revoked = yield* revoke(stored.value.id, workspaceId, link);
	yield* revoked ? File.removeLink(home, workspaceId, link.keyId) : File.markLeaving(home, workspaceId, link.keyId);
	return { workspace: link.name, revoked };
});
