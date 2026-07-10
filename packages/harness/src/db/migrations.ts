import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

// Migrations ship as code (Migrator.fromRecord) rather than .sql files on
// disk, so they survive bundling and need no runtime path resolution.
//
// Keys are "YYYYMMDD<counter>_<label>" (4-digit counter, several per day);
// fromRecord requires the "_<label>" suffix and silently drops keys without
// it. Only the numeric prefix orders migrations, and it must be strictly
// greater than every id already applied — the migrator runs by high-water
// mark, so an id dated before an applied one is silently skipped.
export const migrations = {
	"202607070001_init": Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;

		yield* sql`
			CREATE TABLE project (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;

		yield* sql`
			CREATE TABLE project_directory (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES project(id) ON UPDATE CASCADE ON DELETE CASCADE,
				directory TEXT NOT NULL,
				type TEXT NOT NULL,
				sandbox_env_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;

		yield* sql`
			CREATE UNIQUE INDEX project_directory_project_directory_idx
			ON project_directory (project_id, directory)
		`;

		yield* sql`
			CREATE TABLE session (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES project(id) ON UPDATE CASCADE ON DELETE CASCADE,
				parent_id TEXT REFERENCES session(id) ON UPDATE CASCADE ON DELETE SET NULL,
				slug TEXT NOT NULL,
				directory TEXT NOT NULL,
				title TEXT NOT NULL,
				tag TEXT NOT NULL,
				metadata TEXT,
				cost REAL NOT NULL DEFAULT 0,
				tokens_input INTEGER NOT NULL DEFAULT 0,
				tokens_output INTEGER NOT NULL DEFAULT 0,
				tokens_cache_read INTEGER NOT NULL DEFAULT 0,
				tokens_cache_write INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;

		yield* sql`CREATE UNIQUE INDEX session_slug_idx ON session (slug)`;
		yield* sql`CREATE INDEX session_tag_idx ON session (tag)`;

		// The tree edge is a composite FK (session_id, parent_id) so a parent can
		// never live in another session — cross-session edges would mess up the context
		// NULL parent_id (roots) skips the FK per SQLite.
		// In short: FK (session_id, parent_id); makes sure that a child entry via parent_id must belong
		// to exact same session_id.
		yield* sql`
			CREATE TABLE session_entry (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES session(id) ON UPDATE CASCADE ON DELETE CASCADE,
				parent_id TEXT,
				seq INTEGER NOT NULL,
				type TEXT NOT NULL,
				data TEXT NOT NULL,
				label TEXT,
				metadata TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (session_id, parent_id) REFERENCES session_entry(session_id, id)
			)
		`;

		// Parent key for the composite FKs (SQLite requires a UNIQUE covering
		// the referenced columns).
		yield* sql`CREATE UNIQUE INDEX session_entry_session_id_idx ON session_entry (session_id, id)`;

		yield* sql`
			CREATE TABLE session_entry_part (
				id TEXT PRIMARY KEY,
				entry_id TEXT NOT NULL,
				session_id TEXT NOT NULL REFERENCES session(id) ON UPDATE CASCADE ON DELETE CASCADE,
				part_index INTEGER NOT NULL,
				type TEXT NOT NULL,
				status TEXT,
				call_id TEXT,
				tool_name TEXT,
				data TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				CHECK (type != 'toolCall' OR (status IS NOT NULL AND call_id IS NOT NULL AND tool_name IS NOT NULL)),
				CHECK (type = 'toolCall' OR (status IS NULL AND call_id IS NULL AND tool_name IS NULL)),
				FOREIGN KEY (session_id, entry_id) REFERENCES session_entry(session_id, id) ON UPDATE CASCADE ON DELETE CASCADE
			)
		`;

		yield* sql`ALTER TABLE session ADD COLUMN leaf_entry_id TEXT REFERENCES session_entry(id)`;

		yield* sql`CREATE UNIQUE INDEX session_entry_session_seq_idx ON session_entry (session_id, seq)`;
		yield* sql`CREATE INDEX session_entry_parent_idx ON session_entry (session_id, parent_id)`;
		yield* sql`CREATE INDEX session_entry_type_idx ON session_entry (session_id, type, seq)`;
		yield* sql`CREATE INDEX session_entry_label_idx ON session_entry (session_id, seq) WHERE label IS NOT NULL`;

		yield* sql`CREATE UNIQUE INDEX session_entry_part_entry_idx ON session_entry_part (entry_id, part_index)`;
		yield* sql`CREATE INDEX session_entry_part_call_idx ON session_entry_part (session_id, call_id) WHERE call_id IS NOT NULL`;
		yield* sql`CREATE UNIQUE INDEX session_entry_part_call_uidx ON session_entry_part (entry_id, call_id) WHERE call_id IS NOT NULL`;
		yield* sql`CREATE INDEX session_entry_part_unsettled_idx ON session_entry_part (session_id, status) WHERE status IN ('pending', 'running')`;
		yield* sql`CREATE INDEX session_entry_part_session_idx ON session_entry_part (session_id, entry_id, part_index)`;
	}),
};
