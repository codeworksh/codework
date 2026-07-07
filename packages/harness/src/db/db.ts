import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect, Layer, String as Str } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Global } from "../global";
import { migrations } from "./migrations";

export { SqlClient, SqlSchema } from "effect/unstable/sql";

// PRAGMAs and migrations run once during layer construction; better-sqlite3
// holds a single connection for the lifetime of the layer, so the settings
// apply to every query and a `:memory:` database stays intact across
// transactions — important for serverless deployments and transient sessions
// where no writable disk is available. (WAL is enabled by the client itself.)
const setup = Layer.effectDiscard(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`PRAGMA synchronous = NORMAL`;
		yield* sql`PRAGMA busy_timeout = 5000`;
		yield* sql`PRAGMA cache_size = -64000`;
		yield* sql`PRAGMA foreign_keys = ON`;
		yield* SqliteMigrator.run({ loader: Migrator.fromRecord(migrations) });
	}),
);

// Provides `SqlClient` (and `SqliteClient`) for the database at `location`,
// with column-name transforms so camelCase fields map to snake_case columns.
export function layer(location: string) {
	const client = Layer.unwrap(
		Effect.gen(function* () {
			if (location !== ":memory:") {
				yield* Effect.promise(() => fs.mkdir(dirname(location), { recursive: true }));
			}
			return SqliteClient.layer({
				filename: location,
				transformQueryNames: Str.camelToSnake,
				transformResultNames: Str.snakeToCamel,
			});
		}),
	);
	return setup.pipe(Layer.provideMerge(client), Layer.orDie);
}

export function path() {
	const envPath = process.env.CODEWORK_DB;
	if (envPath) {
		if (envPath === ":memory:" || isAbsolute(envPath)) return envPath;
		return join(Global.Path.data, envPath);
	}
	return join(Global.Path.data, "codework.db");
}

// Deferred so `path()` reads CODEWORK_DB at construction time, not at import.
export const defaultLayer = Layer.unwrap(Effect.sync(() => layer(path())));

export * as Database from "./db";
