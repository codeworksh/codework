import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Relay } from "@codeworksh/schema";
import { Clerk } from "./clerk.ts";

/** People and the workspaces they belong to. */
export class Accounts extends Context.Service<
	Accounts,
	{
		/** The person's account and workspaces, creating the account and its default workspace on first sight. */
		readonly ensure: (authId: string) => Effect.Effect<Relay.Me, Relay.Unavailable>;
		/** A new workspace the person owns. */
		readonly createWorkspace: (authId: string, name: string) => Effect.Effect<Relay.Workspace, Relay.Unavailable>;
	}
>()("relay/Accounts") {
	static readonly layer = Layer.effect(
		Accounts,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const clerk = yield* Clerk;

			const find = (authId: string) =>
				sql<{ readonly id: string; readonly email: string; readonly name: string | null }>`
					SELECT id, email, name FROM account WHERE auth_id = ${authId}
				`.pipe(Effect.map((rows) => rows[0]));

			// Concurrent first calls both reach the insert; the unique auth_id makes the loser wait for the
			// winner's commit and insert nothing, so exactly one default workspace is created.
			const create = Effect.fn("Accounts.create")(function* (authId: string) {
				const profile = yield* clerk.profile(authId);
				const workspaceName = `${profile.firstName ?? profile.email.split("@")[0]}'s Workspace`;
				yield* sql.withTransaction(
					Effect.gen(function* () {
						const created = yield* sql<{ readonly id: string; readonly createdBy: string }>`
							WITH inserted AS (
								INSERT INTO account (auth_id, email, name)
								VALUES (${authId}, ${profile.email}, ${profile.name})
								ON CONFLICT (auth_id) DO NOTHING
								RETURNING id
							)
							INSERT INTO workspace (name, created_by)
							SELECT ${workspaceName}, id FROM inserted
							RETURNING id, created_by
						`;
						for (const workspace of created) {
							yield* sql`
								INSERT INTO member (workspace_id, account_id, role)
								VALUES (${workspace.id}, ${workspace.createdBy}, 'owner')
							`;
						}
					}),
				);
			});

			const ensure = Effect.fn("Accounts.ensure")(
				function* (authId: string) {
					const account = (yield* find(authId)) ?? (yield* create(authId).pipe(Effect.andThen(find(authId))));
					if (account === undefined) return yield* Effect.die(new Error(`No account for ${authId}`));
					const workspaces = yield* sql<{
						readonly id: string;
						readonly name: string;
						readonly role: typeof Relay.Role.Type;
					}>`
							SELECT w.id, w.name, m.role
							FROM member m JOIN workspace w ON w.id = m.workspace_id
							WHERE m.account_id = ${account.id}
							ORDER BY w.created_at, w.id
						`;
					return new Relay.Me({
						account: new Relay.Account(account),
						workspaces: workspaces.map((row) => new Relay.Workspace(row)),
					});
				},
				Effect.catchTag("SqlError", Effect.die),
			);

			return Accounts.of({
				ensure,
				createWorkspace: Effect.fn("Accounts.createWorkspace")(
					function* (authId, name) {
						const { account } = yield* ensure(authId);
						return yield* sql.withTransaction(
							Effect.gen(function* () {
								const [workspace] = yield* sql<{ readonly id: string }>`
								INSERT INTO workspace (name, created_by) VALUES (${name}, ${account.id}) RETURNING id
							`;
								if (workspace === undefined) return yield* Effect.die(new Error("No workspace inserted"));
								yield* sql`
								INSERT INTO member (workspace_id, account_id, role)
								VALUES (${workspace.id}, ${account.id}, 'owner')
							`;
								return new Relay.Workspace({ id: workspace.id, name, role: "owner" });
							}),
						);
					},
					Effect.catchTag("SqlError", Effect.die),
				),
			});
		}),
	);
}
