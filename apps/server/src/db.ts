import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect, Layer, String as Str } from "effect";
import { Migrator, SqlClient } from "effect/sql";

// Migrations ship as code so they survive bundling. Keys are
// "YYYYMMDD<counter>_<label>"; the migrator runs by high-water mark, so a new
// id must sort after every applied one.
const migrations = {
	"202610090001_kv": Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			CREATE TABLE kv (
				package TEXT NOT NULL,
				key TEXT NOT NULL,
				value TEXT NOT NULL,
				updated INTEGER NOT NULL,
				PRIMARY KEY (package, key)
			)
		`;
	}),
};

const setup = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`PRAGMA journal_mode = WAL`;
	yield* sql`PRAGMA synchronous = NORMAL`;
	yield* sql`PRAGMA busy_timeout = 5000`;
	yield* sql`PRAGMA foreign_keys = ON`;
	yield* SqliteMigrator.run({ loader: Migrator.fromRecord(migrations) });
});

/** `SqlClient` for the database file at `filename`, migrated before first use. */
export const layer = (filename: string) =>
	SqliteClient.layer({
		filename,
		transformQueryNames: Str.camelToSnake,
		transformResultNames: Str.snakeToCamel,
	}).pipe(
		Layer.tap((context) => setup.pipe(Effect.provide(context))),
		Layer.orDie,
	);

export * as Db from "./db.ts";
