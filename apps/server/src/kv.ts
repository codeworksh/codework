import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Db } from "./db.ts";

const decodeJson = Schema.decodeUnknownEffect(Db.JsonText);
const encodeJson = Schema.encodeEffect(Db.JsonText);

/** JSON values keyed by package and key; packages never see each other's keys. */
export class Service extends Context.Service<
	Service,
	{
		readonly get: (pkg: string, key: string) => Effect.Effect<Option.Option<Schema.Json>>;
		readonly set: (pkg: string, key: string, value: Schema.Json) => Effect.Effect<void>;
	}
>()("@codeworksh/server/kv/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return Service.of({
			get: Effect.fn("Kv.get")(function* (pkg, key) {
				const rows = yield* sql<{ value: string }>`
					SELECT value FROM kv WHERE package = ${pkg} AND key = ${key}
				`.pipe(Effect.orDie);
				const row = rows[0];
				if (row === undefined) return Option.none();
				return Option.some(yield* decodeJson(row.value).pipe(Effect.orDie));
			}),
			set: Effect.fn("Kv.set")(function* (pkg, key, value) {
				const text = yield* encodeJson(value).pipe(Effect.orDie);
				const updated = yield* Clock.currentTimeMillis;
				yield* sql`
					INSERT INTO kv (package, key, value, updated) VALUES (${pkg}, ${key}, ${text}, ${updated})
					ON CONFLICT (package, key) DO UPDATE SET value = excluded.value, updated = excluded.updated
				`.pipe(Effect.orDie);
			}),
		});
	}),
);

export * as Kv from "./kv.ts";
