import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Clock, Effect, Layer, Schema, String as Str } from "effect";
import { Migrator, SqlClient } from "effect/sql";

// Migrations ship as code so they survive bundling. Keys are
// "YYYYMMDD<counter>_<label>"; the migrator runs by high-water mark, so a new
// id must sort after every applied one.
const migrations = {
	"202610170001_init": Effect.gen(function* () {
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
		yield* sql`
			CREATE TABLE workspaces (
				id TEXT PRIMARY KEY,
				bit INTEGER NOT NULL UNIQUE,
				pos INTEGER NOT NULL,
				name TEXT NOT NULL,
				icon TEXT NOT NULL,
				layout TEXT NOT NULL,
				mfact REAL NOT NULL,
				auto INTEGER NOT NULL DEFAULT 0,
				created INTEGER NOT NULL
			)
		`;
		const created = yield* Clock.currentTimeMillis;
		yield* sql`INSERT INTO workspaces ${sql.insert(
			[
				{ id: "main", name: "Main", icon: "layout-dashboard" },
				{ id: "code", name: "Code", icon: "code" },
				{ id: "notes", name: "Notes", icon: "notebook-pen" },
			].map((workspace, index) => ({ ...workspace, bit: index, pos: index, layout: "tile", mfact: 0.6, created })),
		)}`;
		// AUTOINCREMENT so a seq is never reused, even after the newest rows are deleted.
		yield* sql`
			CREATE TABLE event (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				topic TEXT NOT NULL,
				source TEXT NOT NULL,
				cause TEXT,
				payload TEXT NOT NULL,
				created INTEGER NOT NULL
			)
		`;
		yield* sql`CREATE INDEX event_topic_seq ON event (topic, seq)`;
		yield* sql`CREATE INDEX event_cause ON event (cause)`;
		yield* sql`
			CREATE TABLE widget (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				tags INTEGER NOT NULL,
				tile_pos INTEGER NOT NULL,
				focus_pos INTEGER NOT NULL,
				pinned INTEGER NOT NULL DEFAULT 0,
				props TEXT NOT NULL,
				title TEXT,
				address TEXT,
				params TEXT,
				opened_by TEXT,
				created INTEGER NOT NULL
			)
		`;
	}),
	// The built-in local server takes over its settings, kept until now as single kv entries.
	"202610180001_servers": Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			CREATE TABLE servers (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				name TEXT NOT NULL,
				executable TEXT,
				home TEXT,
				args TEXT NOT NULL DEFAULT '',
				env TEXT NOT NULL DEFAULT '[]',
				is_default INTEGER NOT NULL DEFAULT 0,
				pos INTEGER NOT NULL,
				created INTEGER NOT NULL
			)
		`;
		const rows = yield* sql<{ key: string; value: string }>`
			SELECT key, value FROM kv WHERE package = 'codework' AND key LIKE 'servers.local.%'
		`;
		const saved = new Map(rows.map(({ key, value }) => [key.slice("servers.local.".length), JSON.parse(value)]));
		const text = (key: string) => {
			const value: unknown = saved.get(key);
			return typeof value === "string" && value !== "" ? value : null;
		};
		const env: unknown = saved.get("env");
		yield* sql`INSERT INTO servers ${sql.insert({
			id: "local",
			kind: "local",
			name: text("name") ?? "CodeWork",
			executable: text("executable"),
			home: text("home"),
			args: text("args") ?? "",
			env: JSON.stringify(Array.isArray(env) ? env : []),
			isDefault: 1,
			pos: 0,
			created: yield* Clock.currentTimeMillis,
		})}`;
		yield* sql`DELETE FROM kv WHERE package = 'codework' AND key LIKE 'servers.local.%'`;
	}),
	// Workspace tabs all show the window icon now.
	"202610230001_drop_workspace_icon": Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`ALTER TABLE workspaces DROP COLUMN icon`;
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

/** A JSON value stored as TEXT. */
export const JsonText = Schema.fromJsonString(Schema.Json);

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
