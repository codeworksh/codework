import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Contract, type Tab, type TabCreate, type TabId, type TabOrder, type TabUpdate } from "@codeworksh/contract";

// webwm tag bits a tab may hold; also the Cmd+1–9 keys.
const MAX = 9;

const fail = (message: string) => new Contract.TabError({ message });

/** Tab RPC handlers; the server is the only writer of the table. */
export const handlers = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	// SQLite has no booleans; `auto` is stored as 0 or 1. A label never set is NULL.
	const list = sql<Omit<Tab, "auto" | "label"> & { auto: number; label: string | null }>`
		SELECT id, bit, pos, name, layout, mfact, auto, label FROM tab ORDER BY pos
	`.pipe(
		Effect.map((rows) =>
			rows.map(({ auto, label, ...row }): Tab => ({
				...row,
				auto: auto === 1,
				...(label === null ? {} : { label }),
			})),
		),
		Effect.orDie,
	);

	// Rewrites positions as 0..n-1 in the given order.
	const renumber = (ids: readonly string[]) =>
		Effect.forEach(ids, (id, pos) => sql`UPDATE tab SET pos = ${pos} WHERE id = ${id}`, { discard: true });

	// An auto tab exists to show its frames; one that lost them without being left (a save that
	// never landed) goes at startup, the only time no client is editing.
	yield* sql
		.withTransaction(
			Effect.gen(function* () {
				yield* sql`
					DELETE FROM tab WHERE auto = 1
					AND NOT EXISTS (SELECT 1 FROM widget WHERE (widget.tags & (1 << tab.bit)) != 0)
				`;
				yield* renumber((yield* list).map((tab) => tab.id));
			}),
		)
		.pipe(Effect.orDie);

	return {
		"tabs.list": () => list,

		"tabs.create": Effect.fn("tabs.create")(function* ({ name, auto = false }: typeof TabCreate.Type) {
			return yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const current = yield* list;
						if (current.length >= MAX) return yield* fail(`At most ${MAX} tabs`);
						const used = new Set(current.map((tab) => tab.bit));
						const bit = [...Array(MAX).keys()].find((candidate) => !used.has(candidate)) ?? 0;
						const tab: Tab = {
							id: yield* Effect.sync(() => crypto.randomUUID().slice(0, 8)),
							bit,
							pos: current.length,
							name,
							layout: "tile",
							mfact: 0.6,
							auto,
						};
						const created = yield* Clock.currentTimeMillis;
						yield* sql`INSERT INTO tab ${sql.insert({ ...tab, auto: auto ? 1 : 0, created })}`;
						return tab;
					}),
				)
				.pipe(Effect.catchTag("SqlError", Effect.die));
		}),

		"tabs.update": Effect.fn("tabs.update")(function* ({ id, ...patch }: typeof TabUpdate.Type) {
			const fields = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
			if (Object.keys(fields).length === 0) return;
			const updated = yield* sql<{
				id: string;
			}>`UPDATE tab SET ${sql.update(fields)} WHERE id = ${id} RETURNING id`.pipe(Effect.orDie);
			if (updated.length === 0) return yield* fail(`No tab ${id}`);
		}),

		"tabs.reorder": Effect.fn("tabs.reorder")(function* ({ ids }: typeof TabOrder.Type) {
			yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const current = yield* list;
						const known = new Set(current.map((tab) => tab.id));
						if (
							ids.length !== known.size ||
							new Set(ids).size !== ids.length ||
							!ids.every((id) => known.has(id))
						)
							return yield* fail("The order must name every tab once");
						yield* renumber(ids);
					}),
				)
				.pipe(Effect.catchTag("SqlError", Effect.die));
		}),

		// The deleted bit leaves every widget's mask with it; a widget left on no tab goes too.
		"tabs.delete": Effect.fn("tabs.delete")(function* ({ id }: typeof TabId.Type) {
			yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const current = yield* list;
						const deleted = current.find((tab) => tab.id === id);
						if (deleted === undefined) return yield* fail(`No tab ${id}`);
						yield* sql`DELETE FROM tab WHERE id = ${id}`;
						yield* sql`UPDATE widget SET tags = tags & ~${1 << deleted.bit}`;
						yield* sql`DELETE FROM widget WHERE tags = 0`;
						yield* renumber(current.filter((tab) => tab.id !== id).map((tab) => tab.id));
					}),
				)
				.pipe(Effect.catchTag("SqlError", Effect.die));
		}),
	};
});

export * as Tabs from "./tabs.ts";
