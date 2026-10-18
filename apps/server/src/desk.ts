import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Contract, type Instance } from "@codeworksh/contract";
import { Db } from "./db.ts";

// SQLite has no booleans; `pinned` is stored as 0 or 1.
const Rows = Schema.Array(
	Schema.Struct({
		id: Schema.String,
		kind: Schema.String,
		tags: Schema.Number,
		focusPos: Schema.Number,
		pinned: Schema.Number,
		props: Db.JsonText,
		title: Schema.NullOr(Schema.String),
		address: Schema.NullOr(Schema.String),
		params: Schema.NullOr(Db.JsonText),
		openedBy: Schema.NullOr(Schema.String),
	}),
);
const decodeRows = Schema.decodeUnknownEffect(Rows);
const encodeJson = Schema.encodeEffect(Db.JsonText);

/** Names every instance exactly once. */
const covers = (order: readonly string[], ids: ReadonlySet<string>) =>
	order.length === ids.size && new Set(order).size === order.length && order.every((id) => ids.has(id));

/** Desk RPC handlers; the whole desk is read and replaced at once. */
export const handlers = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	return {
		"desk.get": Effect.fn("desk.get")(function* () {
			const rows = yield* sql`
				SELECT id, kind, tags, focus_pos, pinned, props, title, address, params, opened_by
				FROM widget ORDER BY tile_pos
			`.pipe(Effect.flatMap(decodeRows), Effect.orDie);
			const instances = rows.map(
				({ id, kind, tags, props, pinned, title, address, params, openedBy }): Instance => ({
					id,
					kind,
					tags,
					props,
					pinned: pinned === 1,
					...(title === null ? {} : { title }),
					...(address === null ? {} : { address }),
					...(params === null ? {} : { params }),
					...(openedBy === null ? {} : { openedBy }),
				}),
			);
			const desk: Contract.Desk = {
				instances,
				tileOrder: rows.map((row) => row.id),
				focusOrder: [...rows].sort((a, b) => a.focusPos - b.focusPos).map((row) => row.id),
			};
			return desk;
		}),

		"desk.save": Effect.fn("desk.save")(function* ({ instances, tileOrder, focusOrder }: Contract.Desk) {
			const ids = new Set(instances.map((instance) => instance.id));
			if (ids.size !== instances.length)
				return yield* new Contract.DeskError({ message: "Instance ids must be unique" });
			if (!covers(tileOrder, ids))
				return yield* new Contract.DeskError({ message: "The tile order must name every instance once" });
			if (!covers(focusOrder, ids))
				return yield* new Contract.DeskError({ message: "The focus order must name every instance once" });

			const tilePos = new Map(tileOrder.map((id, pos) => [id, pos]));
			const focusPos = new Map(focusOrder.map((id, pos) => [id, pos]));
			const created = yield* Clock.currentTimeMillis;
			const rows = yield* Effect.forEach(
				instances,
				Effect.fnUntraced(function* (instance) {
					return {
						id: instance.id,
						kind: instance.kind,
						tags: instance.tags,
						tilePos: tilePos.get(instance.id) ?? 0,
						focusPos: focusPos.get(instance.id) ?? 0,
						pinned: instance.pinned ? 1 : 0,
						props: yield* encodeJson(instance.props),
						title: instance.title ?? null,
						address: instance.address ?? null,
						params: instance.params === undefined ? null : yield* encodeJson(instance.params),
						openedBy: instance.openedBy ?? null,
						created,
					};
				}),
			).pipe(Effect.orDie);

			yield* sql
				.withTransaction(
					Effect.gen(function* () {
						yield* sql`DELETE FROM widget`;
						if (rows.length > 0) yield* sql`INSERT INTO widget ${sql.insert(rows)}`;
					}),
				)
				.pipe(Effect.orDie);
		}),
	};
});

export * as Desk from "./desk.ts";
