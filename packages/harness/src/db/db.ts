import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Config, Effect, Layer, String as Str } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";
import { Global } from "../global.ts";
import { fileSystem } from "../host.ts";
import { posix } from "../posix.ts";
import { migrations } from "./migrations.ts";

export { SqlClient, SqlSchema } from "effect/unstable/sql";

// PRAGMAs and migrations run once during layer construction; the node:sqlite
// client holds a single connection for the lifetime of the layer, so the settings
// apply to every query and a `:memory:` database stays intact across
// transactions — important for serverless deployments and transient sessions
// where no writable disk is available. (WAL is enabled by the client itself.)
const setup = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`PRAGMA synchronous = NORMAL`;
	yield* sql`PRAGMA busy_timeout = 5000`;
	yield* sql`PRAGMA cache_size = -64000`;
	yield* sql`PRAGMA foreign_keys = ON`;
	yield* SqliteMigrator.run({ loader: Migrator.fromRecord(migrations) });
});

// Provides `SqlClient` (and `SqliteClient`) for the database at `location`,
// with column-name transforms so camelCase fields map to snake_case columns.
export function layer(location: string) {
	const client = Layer.unwrap(
		Effect.gen(function* () {
			if (location !== ":memory:") {
				yield* fileSystem.makeDirectory(posix.dirname(location), { recursive: true }).pipe(Effect.orDie);
			}
			return SqliteClient.layer({
				filename: location,
				transformQueryNames: Str.camelToSnake,
				transformResultNames: Str.snakeToCamel,
			});
		}),
	);
	return client.pipe(
		Layer.tap((context) => setup.pipe(Effect.provide(context))),
		Layer.orDie,
	);
}

export const locationConfig = Config.string("CODEWORK_DB").pipe(Config.withDefault("codework.db"));

export function resolveLocation(configured: string, data: string) {
	if (configured === ":memory:" || posix.isAbsolute(configured)) return configured;
	return posix.join(data, configured);
}

export const path = Effect.fn("Database.path")(function* (data?: string) {
	const directory = data ?? (yield* Global.resolve()).data;
	return resolveLocation(yield* locationConfig, directory);
});

export const defaultLayer = Layer.unwrap(path().pipe(Effect.map(layer)));

export * as Database from "./db.ts";
