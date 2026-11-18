import { Jws, Relay } from "@codeworksh/schema";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Accounts } from "./accounts.ts";

/** How far a signed request's `iat` may be from the relay's clock. */
const freshness = 60_000;
/** How long a pairing code stays valid, and how often the machine may poll it. */
const pairingSeconds = 600;
const pollSeconds = 5;
/** A pending connect stays listed and approvable while its machine polled this recently. */
const waitingSeconds = 20;
/** After approval, how long the machine has to poll and take the link. */
const claimSeconds = 120;
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
	readonly keyId: string;
	readonly online: boolean;
	readonly lastSeenAt: Date | null;
	readonly revokedAt: Date | null;
}

interface PairingRow {
	readonly id: string;
	readonly workspaceId: string | null;
	readonly machine: Relay.MachineInfo;
	readonly key: Jws.PublicKey;
	readonly keyId: string;
	readonly status: "pending" | "approved" | "active" | "declined" | "superseded";
	readonly approvedBy: string | null;
	readonly connected: Relay.Connected | null;
	readonly expired: boolean;
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
		keyId: row.keyId,
		ownerId: row.ownerId,
		online: row.online,
		lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
	});

const random = (size: number) => globalThis.crypto.getRandomValues(new Uint8Array(size));
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
		readonly pair: (
			jws: string,
		) => Effect.Effect<typeof Relay.PairingCreated.Type, Relay.Unauthorized | Relay.NotFound>;
		readonly poll: (jws: string) => Effect.Effect<Relay.PairingStatus, Relay.Unauthorized | Relay.NotFound>;
		readonly approve: (
			authId: string,
			userCode: string,
			workspaceId: string,
		) => Effect.Effect<{ readonly machine: Relay.MachineInfo }, Relay.NotFound | Relay.Forbidden>;
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

			const member = Effect.fn(function* (authId: string, workspaceId: string) {
				const account = (yield* accounts.ensure(authId)).account;
				const memberRole = yield* role(workspaceId, account.id).pipe(Effect.orDie);
				if (memberRole === undefined) {
					return yield* new Relay.Forbidden({ message: "You are not a member of this workspace" });
				}
				return { account, role: memberRole };
			});

			const machineColumns = sql`
				workspace_id, id, source, local_host_name, given_name, os, arch, version, owner_id, key, key_id,
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

			const pairingColumns = sql`
				id, workspace_id, machine, key, key_id, status, approved_by, connected, expires_at < now() AS expired
			`;

			// The machine proved it holds the approved key: its link goes live under that key, replacing any
			// link the machine had, and every other connect for the same machine and workspace is superseded.
			const activate = (pairingId: string) =>
				sql.withTransaction(
					Effect.gen(function* () {
						const [pairing] = yield* sql<PairingRow>`
							SELECT ${pairingColumns} FROM pairing WHERE id = ${pairingId} FOR UPDATE
						`;
						if (pairing === undefined) return yield* Effect.die(new Error("Pairing vanished"));
						if (pairing.status === "active" && pairing.connected !== null) return pairing.connected;
						if (pairing.status !== "approved" || pairing.workspaceId === null || pairing.approvedBy === null) {
							return undefined;
						}
						const workspaceId = pairing.workspaceId;
						const info = pairing.machine;
						// Replacing a live link keeps its owner; a new or revoked one belongs to the approver.
						const [row] = yield* sql<MachineRow>`
							INSERT INTO machine (
								workspace_id, id, source, local_host_name, given_name, os, arch, version, owner_id, key, key_id
							) VALUES (
								${workspaceId}, ${info.id}, ${info.source}, ${info.localHostName}, ${info.givenName},
								${info.os}, ${info.arch}, ${info.version}, ${pairing.approvedBy},
								${JSON.stringify(pairing.key)}::jsonb, ${pairing.keyId}
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
							UPDATE pairing SET status = 'active', connected = ${JSON.stringify(connected)}::jsonb
							WHERE id = ${pairing.id}
						`;
						yield* sql`
							UPDATE pairing SET status = 'superseded'
							WHERE workspace_id = ${workspaceId} AND machine->>'id' = ${info.id} AND id <> ${pairing.id}
								AND status IN ('pending', 'approved')
						`;
						return connected;
					}),
				);

			return Machines.of({
				pair: Effect.fn("Machines.pair")(
					function* (jws) {
						const header = yield* Jws.peek(jws).pipe(Effect.mapError(() => invalid("Malformed signed request")));
						if (header.jwk === undefined) return yield* invalid("A pairing request embeds its key");
						const claims = yield* Jws.verify(jws, header.jwk).pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Relay.PairingClaims)),
							Effect.mapError(() => invalid("Invalid signed request")),
						);
						yield* fresh(claims.iat);
						const keyId = yield* Jws.thumbprint(header.jwk).pipe(Effect.orDie);
						// A key registers once: reused, it would answer for another connect or link.
						const taken = yield* sql`
							SELECT 1 FROM machine WHERE key_id = ${keyId} UNION ALL SELECT 1 FROM pairing WHERE key_id = ${keyId}
						`;
						if (taken.length > 0) return yield* invalid("This key is already registered");
						if (claims.workspaceId !== null) {
							const workspace = yield* sql`SELECT 1 FROM workspace WHERE id = ${claims.workspaceId}`;
							if (workspace.length === 0) return yield* new Relay.NotFound({ message: "No such workspace" });
						}
						// Finished and abandoned connects are kept a day after their codes expire, then swept.
						yield* sql`DELETE FROM pairing WHERE expires_at < now() - interval '1 day'`;
						const code = userCode();
						yield* sql`
							INSERT INTO pairing (user_code, workspace_id, machine, key, key_id, status, expires_at)
							VALUES (
								${code}, ${claims.workspaceId}, ${JSON.stringify(claims.machine)}::jsonb,
								${JSON.stringify(header.jwk)}::jsonb, ${keyId}, 'pending',
								now() + make_interval(secs => ${pairingSeconds})
							)
						`;
						return { userCode: code, expiresIn: pairingSeconds, interval: pollSeconds };
					},
					Effect.catchTag("SqlError", Effect.die),
				),

				poll: Effect.fn("Machines.poll")(
					function* (jws) {
						const header = yield* Jws.peek(jws).pipe(Effect.mapError(() => invalid("Malformed signed request")));
						if (header.kid === undefined) return yield* invalid("The request names no key");
						const [pairing] = yield* sql<PairingRow>`
							SELECT ${pairingColumns} FROM pairing WHERE key_id = ${header.kid}
						`;
						if (pairing === undefined) return yield* new Relay.NotFound({ message: "Unknown pairing" });
						const claims = yield* Jws.verify(jws, pairing.key).pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Relay.PollClaims)),
							Effect.mapError(() => invalid("Invalid signed request")),
						);
						yield* fresh(claims.iat);
						switch (pairing.status) {
							case "declined":
							case "superseded":
								return { status: pairing.status } as const;
							case "active":
							case "approved": {
								const connected =
									pairing.connected ?? (pairing.expired ? undefined : yield* activate(pairing.id));
								if (connected !== undefined) return { status: "approved", connected } as const;
								// Superseded or expired while this poll waited for the row.
								const [now] = yield* sql<{ readonly status: PairingRow["status"] }>`
									SELECT status FROM pairing WHERE id = ${pairing.id}
								`;
								return { status: now?.status === "superseded" ? "superseded" : "expired" } as const;
							}
							case "pending":
								if (pairing.expired) return { status: "expired" } as const;
								yield* sql`UPDATE pairing SET seen_at = now() WHERE id = ${pairing.id}`;
								return { status: "pending" } as const;
						}
					},
					Effect.catchTag("SqlError", Effect.die),
				),

				approve: Effect.fn("Machines.approve")(function* (authId, code, workspaceId) {
					const approver = (yield* accounts.ensure(authId)).account;
					return yield* sql
						.withTransaction(
							Effect.gen(function* () {
								const [pairing] = yield* sql<{
									readonly id: string;
									readonly workspaceId: string | null;
									readonly machine: Relay.MachineInfo;
									readonly waiting: boolean;
								}>`
									SELECT id, workspace_id, machine,
										seen_at > now() - make_interval(secs => ${waitingSeconds}) AS waiting
									FROM pairing
									WHERE user_code = ${typed(code)} AND status = 'pending' AND expires_at > now()
									FOR UPDATE
								`;
								if (pairing === undefined)
									return yield* new Relay.NotFound({ message: "Unknown or expired code" });
								if (!pairing.waiting) {
									return yield* new Relay.NotFound({
										message: "The machine stopped waiting; run connect on it again",
									});
								}
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
								yield* sql`
									UPDATE pairing SET status = 'approved', approved_by = ${approver.id}, workspace_id = ${workspaceId},
										expires_at = greatest(expires_at, now() + make_interval(secs => ${claimSeconds}))
									WHERE id = ${pairing.id}
								`;
								return { machine: pairing.machine };
							}),
						)
						.pipe(Effect.catchTag("SqlError", Effect.die));
				}),

				list: Effect.fn("Machines.list")(function* (authId, workspaceId) {
					yield* member(authId, workspaceId);
					const rows = yield* sql<MachineRow>`
						SELECT ${machineColumns} FROM machine
						WHERE workspace_id = ${workspaceId} AND revoked_at IS NULL
						ORDER BY created_at, id
					`.pipe(Effect.orDie);
					return rows.map(toMachine);
				}),

				// Only connects started for this workspace are listed: one started without a workspace is
				// claimed by whoever types its code, so it is never shown to a workspace. A connect whose machine
				// stopped polling is gone from the list.
				pairings: Effect.fn("Machines.pairings")(function* (authId, workspaceId) {
					yield* member(authId, workspaceId);
					const rows = yield* sql<{
						readonly userCode: string;
						readonly machine: Relay.MachineInfo;
						readonly status: "pending" | "approved";
						readonly replaces: boolean;
						readonly createdAt: Date;
						readonly expiresAt: Date;
					}>`
						SELECT p.user_code, p.machine, p.status, p.created_at, p.expires_at,
							EXISTS (
								SELECT 1 FROM machine m
								WHERE m.workspace_id = p.workspace_id AND m.id = p.machine->>'id' AND m.revoked_at IS NULL
							) AS replaces
						FROM pairing p
						WHERE p.workspace_id = ${workspaceId} AND p.status IN ('pending', 'approved')
							AND p.expires_at > now() AND p.seen_at > now() - make_interval(secs => ${waitingSeconds})
						ORDER BY p.created_at, p.id
					`.pipe(Effect.orDie);
					return rows.map(
						(row) =>
							new Relay.PendingPairing({
								userCode: row.userCode,
								machine: row.machine,
								status: row.status,
								replaces: row.replaces,
								createdAt: row.createdAt.toISOString(),
								expiresAt: row.expiresAt.toISOString(),
							}),
					);
				}),

				decline: Effect.fn("Machines.decline")(function* (authId, code, workspaceId) {
					yield* member(authId, workspaceId);
					const declined = yield* sql<{ readonly id: string }>`
						UPDATE pairing SET status = 'declined'
						WHERE user_code = ${typed(code)} AND workspace_id = ${workspaceId}
							AND status = 'pending' AND expires_at > now()
						RETURNING id
					`.pipe(Effect.orDie);
					if (declined.length === 0) return yield* new Relay.NotFound({ message: "Unknown or expired code" });
				}),

				remove: Effect.fn("Machines.remove")(function* (authId, workspaceId, machineId) {
					const { account, role: memberRole } = yield* member(authId, workspaceId);
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
							WHERE key_id = ${row.keyId}
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
						yield* sql`UPDATE machine SET revoked_at = now() WHERE key_id = ${row.keyId}`;
					},
					Effect.catchTag("SqlError", Effect.die),
				),
			});
		}),
	);
}
