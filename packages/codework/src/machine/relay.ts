import { NodeServices } from "@effect/platform-node";
import { Jws, Machine, Relay } from "@codeworksh/schema";
import { Clock, Config, Context, Duration, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { uuidv7 } from "uuidv7";
import pkg from "../../package.json" with { type: "json" };
import { hostName } from "../server/identity.ts";
import * as File from "./file.ts";

/** The relay's typed client, at `CODEWORK_RELAY_URL` (default https://relay.codework.sh). */
export class Client extends Context.Service<Client, HttpApiClient.ForApi<typeof Relay.Api>>()(
	"@codeworksh/cli/machine/relay/Client",
) {
	static readonly layer = Layer.effect(
		Client,
		Effect.gen(function* () {
			const baseUrl = yield* Config.String("CODEWORK_RELAY_URL").pipe(
				Config.withDefault("https://relay.codework.sh"),
			);
			return yield* HttpApiClient.make(Relay.Api, { baseUrl });
		}),
	).pipe(Layer.provide(FetchHttpClient.layer));
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
		workspaces: Object.entries(machine.workspaces).map(([id, link]) => ({ id, name: link.name })),
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
 * approves, and saves the link once approved. Each workspace gets its own key.
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
	const claims: Relay.PairingClaims = {
		op: "pairing.create",
		iat: yield* Clock.currentTimeMillis,
		machine: yield* describe(machine),
		workspaceId: options.workspaceId ?? null,
	};
	const pairing = yield* client.machine.pair({
		payload: { jws: yield* Jws.sign(claims, key, { embed: true }) },
	});
	yield* options.onCode(pairing.userCode);

	const deadline = (yield* Clock.currentTimeMillis) + pairing.expiresIn * 1000;
	while ((yield* Clock.currentTimeMillis) < deadline) {
		yield* Effect.sleep(Duration.seconds(pairing.interval));
		const status = yield* client.machine.poll({ payload: { deviceCode: pairing.deviceCode } });
		if (status.status === "expired") break;
		if (status.status === "approved") {
			const { connected } = status;
			const keyId = yield* Jws.thumbprint(Jws.publicOf(key));
			yield* File.update(options.home, {}, (current) =>
				Effect.succeed({
					...current,
					workspaces: {
						...current.workspaces,
						[connected.workspace.id]: { name: connected.workspace.name, owner: connected.owner, key, keyId },
					},
				}),
			);
			return connected;
		}
	}
	return yield* new Machine.ConnectError({ message: "The code expired before it was approved; run connect again" });
});

/** One heartbeat per connected workspace. A link the relay no longer knows is removed here too. */
export const heartbeat = Effect.fn("Machine.heartbeat")(function* (home: string) {
	const client = yield* Client;
	const stored = yield* File.read(home);
	if (stored._tag === "None") return;
	const machine = stored.value;
	const info = yield* describe(machine);
	for (const [workspaceId, link] of Object.entries(machine.workspaces)) {
		const claims: Relay.HeartbeatClaims = {
			op: "machine.heartbeat",
			iat: yield* Clock.currentTimeMillis,
			workspaceId,
			machine: info,
		};
		yield* client.machine
			.heartbeat({ payload: { jws: yield* Jws.sign(claims, link.key, { kid: link.keyId }) } })
			.pipe(
				Effect.catchTag("Relay.MachineRevoked", (revoked) =>
					Effect.logWarning(`Disconnected from ${link.name}: ${revoked.message}`).pipe(
						Effect.andThen(File.removeLink(home, workspaceId)),
					),
				),
				Effect.catch((error) => Effect.logDebug(`Heartbeat to ${link.name} failed`, error)),
			);
	}
});

/**
 * Leaves a workspace: asks the relay to revoke this machine's link, then forgets it locally. The
 * local link is removed even when the relay can't be reached; `revoked` says whether it confirmed.
 */
export const disconnect = Effect.fn("Machine.disconnect")(function* (home: string, workspaceId: string) {
	const client = yield* Client;
	const stored = yield* File.read(home);
	const link = stored._tag === "Some" ? stored.value.workspaces[workspaceId] : undefined;
	if (stored._tag === "None" || link === undefined) {
		return yield* new Machine.ConnectError({ message: `This machine is not connected to workspace ${workspaceId}` });
	}
	const claims: Relay.RevokeClaims = {
		op: "machine.revoke",
		iat: yield* Clock.currentTimeMillis,
		jti: uuidv7(),
		workspaceId,
		machineId: stored.value.id,
	};
	const revoked = yield* client.machine
		.revoke({ payload: { jws: yield* Jws.sign(claims, link.key, { kid: link.keyId }) } })
		.pipe(
			Effect.as(true),
			Effect.catchTag("Relay.MachineRevoked", () => Effect.succeed(true)),
			Effect.orElseSucceed(() => false),
		);
	yield* File.removeLink(home, workspaceId);
	return { workspace: link.name, revoked };
});
