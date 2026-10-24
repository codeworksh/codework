import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import {
	Contract,
	type Workspace,
	type WorkspaceCreate,
	type WorkspaceId,
	type WorkspaceOrder,
	type WorkspaceUpdate,
} from "@codeworksh/contract";

// webwm tag bits a workspace may hold; also the Cmd+1–9 keys.
const MAX = 9;

const fail = (message: string) => new Contract.WorkspaceError({ message });

/** Workspace RPC handlers; the server is the only writer of the table. */
export const handlers = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	// SQLite has no booleans; `auto` is stored as 0 or 1. A tab never set is NULL.
	const list = sql<Omit<Workspace, "auto" | "tab"> & { auto: number; tab: string | null }>`
		SELECT id, bit, pos, name, layout, mfact, auto, tab FROM workspaces ORDER BY pos
	`.pipe(
		Effect.map((rows) =>
			rows.map(({ auto, tab, ...row }): Workspace => ({
				...row,
				auto: auto === 1,
				...(tab === null ? {} : { tab }),
			})),
		),
		Effect.orDie,
	);

	// Rewrites positions as 0..n-1 in the given order.
	const renumber = (ids: readonly string[]) =>
		Effect.forEach(ids, (id, pos) => sql`UPDATE workspaces SET pos = ${pos} WHERE id = ${id}`, { discard: true });

	// An auto workspace exists to show its frames; one that lost them without being left (a save that
	// never landed) goes at startup, the only time no client is editing.
	yield* sql
		.withTransaction(
			Effect.gen(function* () {
				yield* sql`
					DELETE FROM workspaces WHERE auto = 1
					AND NOT EXISTS (SELECT 1 FROM widget WHERE (widget.tags & (1 << workspaces.bit)) != 0)
				`;
				yield* renumber((yield* list).map((workspace) => workspace.id));
			}),
		)
		.pipe(Effect.orDie);

	return {
		"workspaces.list": () => list,

		"workspaces.create": Effect.fn("workspaces.create")(function* ({
			name,
			auto = false,
		}: typeof WorkspaceCreate.Type) {
			return yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const current = yield* list;
						if (current.length >= MAX) return yield* fail(`At most ${MAX} workspaces`);
						const used = new Set(current.map((workspace) => workspace.bit));
						const bit = [...Array(MAX).keys()].find((candidate) => !used.has(candidate)) ?? 0;
						const workspace: Workspace = {
							id: yield* Effect.sync(() => crypto.randomUUID().slice(0, 8)),
							bit,
							pos: current.length,
							name,
							layout: "tile",
							mfact: 0.6,
							auto,
						};
						const created = yield* Clock.currentTimeMillis;
						yield* sql`INSERT INTO workspaces ${sql.insert({ ...workspace, auto: auto ? 1 : 0, created })}`;
						return workspace;
					}),
				)
				.pipe(Effect.catchTag("SqlError", Effect.die));
		}),

		"workspaces.update": Effect.fn("workspaces.update")(function* ({ id, ...patch }: typeof WorkspaceUpdate.Type) {
			const fields = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
			if (Object.keys(fields).length === 0) return;
			const updated = yield* sql<{
				id: string;
			}>`UPDATE workspaces SET ${sql.update(fields)} WHERE id = ${id} RETURNING id`.pipe(Effect.orDie);
			if (updated.length === 0) return yield* fail(`No workspace ${id}`);
		}),

		"workspaces.reorder": Effect.fn("workspaces.reorder")(function* ({ ids }: typeof WorkspaceOrder.Type) {
			yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const current = yield* list;
						const known = new Set(current.map((workspace) => workspace.id));
						if (
							ids.length !== known.size ||
							new Set(ids).size !== ids.length ||
							!ids.every((id) => known.has(id))
						)
							return yield* fail("The order must name every workspace once");
						yield* renumber(ids);
					}),
				)
				.pipe(Effect.catchTag("SqlError", Effect.die));
		}),

		// The deleted bit leaves every widget's mask with it; a widget left on no workspace goes too.
		"workspaces.delete": Effect.fn("workspaces.delete")(function* ({ id }: typeof WorkspaceId.Type) {
			yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const current = yield* list;
						const deleted = current.find((workspace) => workspace.id === id);
						if (deleted === undefined) return yield* fail(`No workspace ${id}`);
						yield* sql`DELETE FROM workspaces WHERE id = ${id}`;
						yield* sql`UPDATE widget SET tags = tags & ~${1 << deleted.bit}`;
						yield* sql`DELETE FROM widget WHERE tags = 0`;
						yield* renumber(current.filter((workspace) => workspace.id !== id).map((workspace) => workspace.id));
					}),
				)
				.pipe(Effect.catchTag("SqlError", Effect.die));
		}),
	};
});

export * as Workspaces from "./workspaces.ts";
