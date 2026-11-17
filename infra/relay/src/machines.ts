import { Jws, Relay } from "@codeworksh/schema";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { Base64Url, Hex } from "effect/encoding";
import { SqlClient } from "effect/sql";
import { Accounts } from "./accounts.ts";

/** How far a signed request's `iat` may be from the relay's clock. */
const freshness = 60_000;
/** How long a pairing code stays valid, and how often the machine may poll it. */
const pairingSeconds = 600;
const pollSeconds = 5;
/** A machine is online while its last heartbeat is younger than this. */
const leaseSeconds = 90;
/** Unambiguous letters for codes a person reads and types. */
const alphabet = "BCDFGHJKLMNPQRSTVWXZ";

interface MachineRow {
	readonly workspaceId: string;
	readonly id: string;
	readonly source: Relay.MachineInfo["source"];
	readonly localHostName: string;
	readonly givenName: string | null;
	readonly os: string;
	readonly arch: string;
	readonly version: string;
	readonly ownerId: string;
	readonly key: Jws.PublicKey;
	readonly online: boolean;
	readonly lastSeenAt: Date | null;
	readonly revokedAt: Date | null;
}

const toMachine = (row: MachineRow) =>
	new Relay.Machine({
		workspaceId: row.workspaceId,
		id: row.id,
		source: row.source,
		localHostName: row.localHostName,
		givenName: row.givenName,
		os: row.os,
		arch: row.arch,
		version: row.version,
		ownerId: row.ownerId,
		online: row.online,
		lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
	});

const random = (size: number) => globalThis.crypto.getRandomValues(new Uint8Array(size));
const sha256 = (value: string) =>
	Effect.promise(() => globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
		Effect.map((digest) => Hex.encode(new Uint8Array(digest))),
	);
const userCode = () => {
	const letters = Array.from(random(8), (byte) => alphabet[byte % alphabet.length]).join("");
	return `${letters.slice(0, 4)}-${letters.slice(4)}`;
};
/** A code as people type it, in any case and with or without its dash or spaces, as stored. */
const typed = (code: string) => {
	const letters = code.toUpperCase().replace(/[^A-Z]/g, "");
	return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : code.toUpperCase();
};

const invalid = (message: string) => new Relay.Unauthorized({ message });

/** Pairings, machine links and their heartbeats. */
export class Machines extends Context.Service<
	Machines,
	{
		readonly pair: (jws: string) => Effect.Effect<typeof Relay.PairingCreated.Type, Relay.Unauthorized>;
		readonly poll: (deviceCode: string) => Effect.Effect<Relay.PairingStatus, Relay.NotFound>;
		readonly approve: (
			authId: string,
			userCode: string,
			workspaceId: string,
		) => Effect.Effect<Relay.Machine, Relay.NotFound | Relay.Forbidden>;
		readonly list: (
			authId: string,
			workspaceId: string,
		) => Effect.Effect<ReadonlyArray<Relay.Machine>, Relay.Forbidden>;
		readonly pairings: (
			authId: string,
			workspaceId: string,
		) => Effect.Effect<ReadonlyArray<Relay.PendingPairing>, Relay.Forbidden>;
		readonly decline: (
			authId: string,
			userCode: string,
			workspaceId: string,
		) => Effect.Effect<void, Relay.NotFound | Relay.Forbidden>;
		readonly remove: (
			authId: string,
			workspaceId: string,
			machineId: string,
		) => Effect.Effect<void, Relay.NotFound | Relay.Forbidden>;
		readonly heartbeat: (jws: string) => Effect.Effect<void, Relay.Unauthorized | Relay.MachineRevoked>;
		readonly revoke: (jws: string) => Effect.Effect<void, Relay.Unauthorized | Relay.MachineRevoked>;
	}
>()("relay/Machines") {
	static readonly layer = Layer.effect(
		Machines,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const accounts = yield* Accounts;

			const fresh = Effect.fn(function* (iat: number) {
				const now = yield* Clock.currentTimeMillis;
				if (Math.abs(now - iat) > freshness) return yield* invalid("The request is too old or from the future");
			});

			const role = (workspaceId: string, accountId: string) =>
				sql<{ readonly role: typeof Relay.Role.Type }>`
					SELECT role FROM member WHERE workspace_id = ${workspaceId} AND account_id = ${accountId}
				`.pipe(Effect.map((rows) => rows[0]?.role));

			const machineColumns = sql`
				workspace_id, id, source, local_host_name, given_name, os, arch, version, owner_id, key,
				last_seen_at, revoked_at, coalesce(last_seen_at > now() - make_interval(secs => ${leaseSeconds}), false) AS online
			`;

			// A machine request names its key by thumbprint; the key finds the one link it may act on.
			const signed = Effect.fn("Machines.signed")(function* <A extends { readonly iat: number }>(
				jws: string,
				claims: Schema.Decoder<A>,
			) {
				const header = yield* Jws.peek(jws).pipe(Effect.mapError(() => invalid("Malformed signed request")));
				if (header.kid === undefined) return yield* invalid("The request names no key");
				const [row] = yield* sql<MachineRow>`SELECT ${machineColumns} FROM machine WHERE key_id = ${header.kid}`;
				if (row === undefined) return yield* new Relay.MachineRevoked({ message: "This machine is not connected" });
				const decoded = yield* Jws.verify(jws, row.key).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(claims)),
					Effect.mapError(() => invalid("Invalid signed request")),
				);
				yield* fresh(decoded.iat);
				if (row.revokedAt !== null)
					return yield* new Relay.MachineRevoked({ message: "This machine was disconnected" });
				if ((yield* role(row.workspaceId, row.ownerId)) === undefined) {
					return yield* new Relay.MachineRevoked({ message: "The machine's owner left the workspace" });
				}
				return { row, claims: decoded };
			});

			return Machines.of({
				pair: Effect.fn("Machines.pair")(function* (jws) {
					const header = yield* Jws.peek(jws).pipe(Effect.mapError(() => invalid("Malformed signed request")));
					if (header.jwk === undefined) return yield* invalid("A pairing request embeds its key");
					const claims = yield* Jws.verify(jws, header.jwk).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Relay.PairingClaims)),
						Effect.mapError(() => invalid("Invalid signed request")),
					);
					yield* fresh(claims.iat);
					const keyId = yield* Jws.thumbprint(header.jwk).pipe(Effect.orDie);
					const deviceCode = Base64Url.encode(random(32));
					const code = userCode();
					yield* sql`
							INSERT INTO pairing (code_hash, user_code, workspace_id, machine, key, key_id, status, expires_at)
							VALUES (
								${yield* sha256(deviceCode)}, ${code}, ${claims.workspaceId},
								${JSON.stringify(claims.machine)}::jsonb, ${JSON.stringify(header.jwk)}::jsonb, ${keyId},
								'pending', now() + make_interval(secs => ${pairingSeconds})
							)
						`.pipe(Effect.orDie);
					return { deviceCode, userCode: code, expiresIn: pairingSeconds, interval: pollSeconds };
				}),

				poll: Effect.fn("Machines.poll")(function* (deviceCode) {
					const [row] = yield* sql<{
						readonly status: "pending" | "approved" | "declined";
						readonly expired: boolean;
						readonly connected: Relay.Connected | null;
					}>`
						SELECT status, expires_at < now() AS expired, connected FROM pairing
						WHERE code_hash = ${yield* sha256(deviceCode)}
					`.pipe(Effect.orDie);
					if (row === undefined) return yield* new Relay.NotFound({ message: "Unknown pairing" });
					if (row.status === "approved" && row.connected !== null) {
						return { status: "approved", connected: row.connected } as const;
					}
					if (row.status === "declined") return { status: "declined" } as const;
					return { status: row.expired ? "expired" : "pending" } as const;
				}),

				approve: Effect.fn("Machines.approve")(function* (authId, code, workspaceId) {
					const approver = (yield* accounts.ensure(authId)).account;
					return yield* sql
						.withTransaction(
							Effect.gen(function* () {
								const [pairing] = yield* sql<{
									readonly id: string;
									readonly workspaceId: string | null;
									readonly machine: Relay.MachineInfo;
									readonly key: Jws.PublicKey;
									readonly keyId: string;
								}>`
									SELECT id, workspace_id, machine, key, key_id FROM pairing
									WHERE user_code = ${typed(code)} AND status = 'pending' AND expires_at > now()
									FOR UPDATE
								`;
								if (pairing === undefined)
									return yield* new Relay.NotFound({ message: "Unknown or expired code" });
								if (pairing.workspaceId !== null && pairing.workspaceId !== workspaceId) {
									return yield* new Relay.Forbidden({
										message: "This code was started for another workspace",
									});
								}
								const approverRole = yield* role(workspaceId, approver.id);
								if (approverRole === undefined) {
									return yield* new Relay.Forbidden({ message: "You are not a member of this workspace" });
								}
								const [existing] = yield* sql<{ readonly ownerId: string }>`
									SELECT owner_id FROM machine
									WHERE workspace_id = ${workspaceId} AND id = ${pairing.machine.id} AND revoked_at IS NULL
								`;
								if (existing !== undefined && existing.ownerId !== approver.id && approverRole === "member") {
									return yield* new Relay.Forbidden({
										message: "Only the machine's owner or a workspace admin can replace it",
									});
								}
								const info = pairing.machine;
								// Replacing a live link keeps its owner; a new or revoked one belongs to the approver.
								const [row] = yield* sql<MachineRow>`
									INSERT INTO machine (
										workspace_id, id, source, local_host_name, given_name, os, arch, version, owner_id, key, key_id
									) VALUES (
										${workspaceId}, ${info.id}, ${info.source}, ${info.localHostName}, ${info.givenName},
										${info.os}, ${info.arch}, ${info.version}, ${approver.id}, ${JSON.stringify(pairing.key)}::jsonb,
										${pairing.keyId}
									)
									ON CONFLICT (workspace_id, id) DO UPDATE SET
										source = excluded.source, local_host_name = excluded.local_host_name,
										given_name = excluded.given_name, os = excluded.os, arch = excluded.arch,
										version = excluded.version, key = excluded.key, key_id = excluded.key_id,
										owner_id = CASE WHEN machine.revoked_at IS NULL THEN machine.owner_id ELSE excluded.owner_id END,
										last_seen_at = NULL, revoked_at = NULL
									RETURNING ${machineColumns}
								`;
								if (row === undefined) return yield* Effect.die(new Error("Machine upsert returned no row"));
								const [workspace] = yield* sql<{ readonly name: string }>`
									SELECT name FROM workspace WHERE id = ${workspaceId}
								`;
								const [owner] = yield* sql<{ readonly name: string | null }>`
									SELECT name FROM account WHERE id = ${row.ownerId}
								`;
								const connected: Relay.Connected = {
									machineId: row.id,
									workspace: { id: workspaceId, name: workspace?.name ?? "" },
									owner: { id: row.ownerId, name: owner?.name ?? null },
								};
								yield* sql`
									UPDATE pairing SET status = 'approved', approved_by = ${approver.id},
										connected = ${JSON.stringify(connected)}::jsonb
									WHERE id = ${pairing.id}
								`;
								return toMachine(row);
							}),
						)
						.pipe(Effect.catchTag("SqlError", Effect.die));
				}),

				list: Effect.fn("Machines.list")(function* (authId, workspaceId) {
					const account = (yield* accounts.ensure(authId)).account;
					if ((yield* role(workspaceId, account.id).pipe(Effect.orDie)) === undefined) {
						return yield* new Relay.Forbidden({ message: "You are not a member of this workspace" });
					}
					const rows = yield* sql<MachineRow>`
						SELECT ${machineColumns} FROM machine
						WHERE workspace_id = ${workspaceId} AND revoked_at IS NULL
						ORDER BY created_at, id
					`.pipe(Effect.orDie);
					return rows.map(toMachine);
				}),

				// Only connects started for this workspace are listed: one started without a workspace is
				// claimed by whoever types its code, so it is never shown to a workspace.
				pairings: Effect.fn("Machines.pairings")(function* (authId, workspaceId) {
					const account = (yield* accounts.ensure(authId)).account;
					if ((yield* role(workspaceId, account.id).pipe(Effect.orDie)) === undefined) {
						return yield* new Relay.Forbidden({ message: "You are not a member of this workspace" });
					}
					const rows = yield* sql<{
						readonly userCode: string;
						readonly machine: Relay.MachineInfo;
						readonly createdAt: Date;
						readonly expiresAt: Date;
					}>`
						SELECT user_code, machine, created_at, expires_at FROM pairing
						WHERE workspace_id = ${workspaceId} AND status = 'pending' AND expires_at > now()
						ORDER BY created_at, id
					`.pipe(Effect.orDie);
					return rows.map(
						(row) =>
							new Relay.PendingPairing({
								userCode: row.userCode,
								machine: row.machine,
								createdAt: row.createdAt.toISOString(),
								expiresAt: row.expiresAt.toISOString(),
							}),
					);
				}),

				decline: Effect.fn("Machines.decline")(function* (authId, code, workspaceId) {
					const account = (yield* accounts.ensure(authId)).account;
					if ((yield* role(workspaceId, account.id).pipe(Effect.orDie)) === undefined) {
						return yield* new Relay.Forbidden({ message: "You are not a member of this workspace" });
					}
					const declined = yield* sql<{ readonly id: string }>`
						UPDATE pairing SET status = 'declined'
						WHERE user_code = ${typed(code)} AND workspace_id = ${workspaceId}
							AND status = 'pending' AND expires_at > now()
						RETURNING id
					`.pipe(Effect.orDie);
					if (declined.length === 0) return yield* new Relay.NotFound({ message: "Unknown or expired code" });
				}),

				remove: Effect.fn("Machines.remove")(function* (authId, workspaceId, machineId) {
					const account = (yield* accounts.ensure(authId)).account;
					const memberRole = yield* role(workspaceId, account.id).pipe(Effect.orDie);
					if (memberRole === undefined) {
						return yield* new Relay.Forbidden({ message: "You are not a member of this workspace" });
					}
					const [machine] = yield* sql<{ readonly ownerId: string }>`
						SELECT owner_id FROM machine
						WHERE workspace_id = ${workspaceId} AND id = ${machineId} AND revoked_at IS NULL
					`.pipe(Effect.orDie);
					if (machine === undefined)
						return yield* new Relay.NotFound({ message: "No such machine in this workspace" });
					if (machine.ownerId !== account.id && memberRole === "member") {
						return yield* new Relay.Forbidden({
							message: "Only the machine's owner or a workspace admin can remove it",
						});
					}
					yield* sql`
						UPDATE machine SET revoked_at = now() WHERE workspace_id = ${workspaceId} AND id = ${machineId}
					`.pipe(Effect.orDie);
				}),

				heartbeat: Effect.fn("Machines.heartbeat")(
					function* (jws) {
						const { row, claims } = yield* signed(jws, Relay.HeartbeatClaims);
						if (claims.workspaceId !== row.workspaceId || claims.machine.id !== row.id) {
							return yield* invalid("The request names another machine");
						}
						const info = claims.machine;
						yield* sql`
						UPDATE machine SET last_seen_at = now(), local_host_name = ${info.localHostName},
							given_name = ${info.givenName}, os = ${info.os}, arch = ${info.arch}, version = ${info.version}
						WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}
					`;
					},
					Effect.catchTag("SqlError", Effect.die),
				),

				revoke: Effect.fn("Machines.revoke")(
					function* (jws) {
						const { row, claims } = yield* signed(jws, Relay.RevokeClaims);
						if (claims.workspaceId !== row.workspaceId || claims.machineId !== row.id) {
							return yield* invalid("The request names another machine");
						}
						// A jti is kept for twice the freshness window: past that, its iat already refuses a replay.
						yield* sql`DELETE FROM assertion WHERE expires_at < now()`;
						const accepted = yield* sql`
						INSERT INTO assertion (jti, expires_at)
						VALUES (${claims.jti}, now() + make_interval(secs => ${(2 * freshness) / 1000}))
						ON CONFLICT (jti) DO NOTHING RETURNING jti
					`;
						if (accepted.length === 0) return yield* invalid("This request was already used");
						yield* sql`
						UPDATE machine SET revoked_at = now() WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}
					`;
					},
					Effect.catchTag("SqlError", Effect.die),
				),
			});
		}),
	);
}
