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
		// `tab` is what the workspace's tab last read, so a workspace not yet opened since a restart names what it shows.
		yield* sql`
			CREATE TABLE workspaces (
				id TEXT PRIMARY KEY,
				bit INTEGER NOT NULL UNIQUE,
				pos INTEGER NOT NULL,
				name TEXT NOT NULL,
				layout TEXT NOT NULL,
				mfact REAL NOT NULL,
				auto INTEGER NOT NULL DEFAULT 0,
				created INTEGER NOT NULL,
				tab TEXT
			)
		`;
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

		// The sync's copy of each machine's CodeWork: core columns are written only by the sync,
		// desktop columns only by this app.
		yield* sql`
			CREATE TABLE machine (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				name TEXT NOT NULL,
				executable TEXT,
				home TEXT,
				args TEXT NOT NULL DEFAULT '',
				env TEXT NOT NULL DEFAULT '[]',
				url TEXT,
				namespace TEXT NOT NULL,
				is_default INTEGER NOT NULL DEFAULT 0,
				pos INTEGER NOT NULL,
				store_id TEXT UNIQUE,
				cursor INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL
			)
		`;
		yield* sql`
			CREATE TABLE organization (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;
		yield* sql`
			CREATE TABLE grouping (
				id TEXT PRIMARY KEY,
				organization_id TEXT NOT NULL REFERENCES organization(id),
				name TEXT NOT NULL,
				color TEXT,
				ordering REAL NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;
		yield* sql`CREATE INDEX grouping_ordering_idx ON grouping (organization_id, ordering)`;
		// Core ids are repo hashes, so the same repo on two machines collides: keyed by machine too.
		yield* sql`
			CREATE TABLE project (
				machine_id TEXT NOT NULL REFERENCES machine(id) ON DELETE CASCADE,
				id TEXT NOT NULL,
				organization_id TEXT NOT NULL REFERENCES organization(id),
				namespace TEXT NOT NULL,
				name TEXT NOT NULL,
				status TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (machine_id, id)
			)
		`;
		yield* sql`CREATE INDEX project_organization_idx ON project (organization_id, namespace, status)`;
		yield* sql`
			CREATE TABLE space (
				machine_id TEXT NOT NULL,
				id TEXT NOT NULL,
				organization_id TEXT NOT NULL REFERENCES organization(id),
				project_id TEXT NOT NULL,
				location TEXT NOT NULL,
				kind TEXT NOT NULL,
				env TEXT,
				status TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (machine_id, id),
				FOREIGN KEY (machine_id, project_id) REFERENCES project(machine_id, id) ON DELETE CASCADE
			)
		`;
		yield* sql`CREATE INDEX space_project_idx ON space (machine_id, project_id)`;
		yield* sql`
			CREATE TABLE session (
				id TEXT PRIMARY KEY,
				machine_id TEXT NOT NULL REFERENCES machine(id) ON DELETE CASCADE,
				organization_id TEXT NOT NULL REFERENCES organization(id),
				space_id TEXT NOT NULL,
				slug TEXT NOT NULL,
				dir TEXT NOT NULL,
				hostdir TEXT,
				tag TEXT,
				metadata TEXT,
				color TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				deleted_at INTEGER,
				FOREIGN KEY (machine_id, space_id) REFERENCES space(machine_id, id)
			)
		`;
		yield* sql`CREATE INDEX session_space_idx ON session (machine_id, space_id)`;
		yield* sql`CREATE INDEX session_list_idx ON session (organization_id, updated_at) WHERE deleted_at IS NULL`;
		// No FK on origin_thread_id: a source can arrive after its fork.
		yield* sql`
			CREATE TABLE thread (
				id TEXT PRIMARY KEY,
				organization_id TEXT NOT NULL REFERENCES organization(id),
				session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
				origin_kind TEXT NOT NULL,
				origin_thread_id TEXT,
				origin_entry_id TEXT,
				origin_call_id TEXT,
				origin_committed_seq INTEGER,
				title TEXT,
				model_provider TEXT,
				model_id TEXT,
				thinking_level TEXT,
				foundation TEXT,
				placement_space_id TEXT,
				placement_dir TEXT,
				parked INTEGER NOT NULL DEFAULT 0,
				restarts INTEGER NOT NULL DEFAULT 0,
				attempt INTEGER,
				run_state TEXT NOT NULL DEFAULT 'idle',
				run_state_at INTEGER,
				run_started_at INTEGER,
				run_ended_at INTEGER,
				run_outcome TEXT,
				run_error TEXT,
				cost REAL NOT NULL DEFAULT 0,
				tokens_input INTEGER NOT NULL DEFAULT 0,
				tokens_output INTEGER NOT NULL DEFAULT 0,
				tokens_cache_read INTEGER NOT NULL DEFAULT 0,
				tokens_cache_write INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL,
				status_at INTEGER NOT NULL,
				priority INTEGER NOT NULL DEFAULT 0,
				grouping_id TEXT REFERENCES grouping(id) ON DELETE SET NULL,
				ordering REAL NOT NULL,
				color TEXT,
				cursor INTEGER,
				floor INTEGER,
				created_seq INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				deleted_at INTEGER
			)
		`;
		yield* sql`CREATE UNIQUE INDEX thread_main_idx ON thread (session_id) WHERE origin_kind = 'main'`;
		yield* sql`CREATE INDEX thread_session_idx ON thread (session_id, updated_at) WHERE deleted_at IS NULL`;
		yield* sql`CREATE INDEX thread_origin_idx ON thread (origin_thread_id) WHERE origin_thread_id IS NOT NULL`;
		yield* sql`CREATE INDEX thread_status_idx ON thread (organization_id, status, ordering) WHERE deleted_at IS NULL`;
		yield* sql`CREATE INDEX thread_grouping_idx ON thread (organization_id, grouping_id, ordering) WHERE deleted_at IS NULL`;
		yield* sql`CREATE INDEX thread_priority_idx ON thread (organization_id, priority, ordering) WHERE deleted_at IS NULL`;
		yield* sql`
			CREATE TABLE entry (
				id TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
				seq INTEGER NOT NULL,
				type TEXT NOT NULL,
				state TEXT NOT NULL,
				error TEXT,
				size INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;
		yield* sql`CREATE UNIQUE INDEX entry_thread_idx ON entry (thread_id, seq)`;
		yield* sql`CREATE INDEX entry_draft_idx ON entry (thread_id) WHERE state = 'draft'`;
		yield* sql`
			CREATE TABLE part (
				entry_id TEXT NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
				part_index INTEGER NOT NULL,
				type TEXT NOT NULL,
				status TEXT,
				call_id TEXT,
				tool_name TEXT,
				data TEXT NOT NULL,
				PRIMARY KEY (entry_id, part_index)
			)
		`;
		yield* sql`CREATE UNIQUE INDEX part_call_idx ON part (entry_id, call_id) WHERE call_id IS NOT NULL`;
		yield* sql`CREATE INDEX part_unsettled_idx ON part (entry_id) WHERE status IN ('pending', 'running')`;
		yield* sql`
			CREATE TABLE inbox (
				id TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
				delivery TEXT NOT NULL,
				text TEXT NOT NULL,
				admitted_seq INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			)
		`;
		yield* sql`CREATE UNIQUE INDEX inbox_thread_idx ON inbox (thread_id, admitted_seq)`;

		const now = yield* Clock.currentTimeMillis;
		// The built-in local machine runs the CLI home's CodeWork: a null executable and home are the ones found.
		yield* sql`INSERT INTO machine ${sql.insert({
			id: "local",
			kind: "local",
			name: "CodeWork",
			namespace: "codework",
			isDefault: 1,
			pos: 0,
			createdAt: now,
		})}`;
		// The one organization the UI uses until auth exists.
		yield* sql`INSERT INTO organization ${sql.insert({ id: "personal", name: "Personal", createdAt: now, updatedAt: now })}`;
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
