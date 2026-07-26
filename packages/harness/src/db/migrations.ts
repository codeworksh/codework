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

		// A durable filesystem namespace. Created before project_directory and
		// session because both reference it. Reference counts are deliberately
		// absent: they live in control-plane memory, since a persisted count cannot
		// tell whether the process that took it is still running.
		//
		// The host is never a row. `local` is a reserved id that exists at runtime
		// and never reaches a column; NULL is its only storage form, so nothing has
		// to be seeded or repaired for a session to exist.
		yield* sql`
			CREATE TABLE sandbox_instance (
				id TEXT PRIMARY KEY CHECK (id <> 'local'),
				driver TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('local', 'virtual', 'remote')),
				provider_resource_id TEXT,
				runtime_config TEXT,
				ownership TEXT NOT NULL CHECK (ownership IN ('managed', 'external')),
				status TEXT NOT NULL,
				provider_status TEXT,
				state_observed_at INTEGER NOT NULL,
				metadata TEXT,
				last_error TEXT,
				last_mounted_at INTEGER,
				last_unmounted_at INTEGER,
				last_used_at INTEGER,
				removed_at INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;

		// One live instance per driver resource: two application identities for
		// one namespace would alias, which is the thing instance IDs exist to
		// prevent. Tombstones are excluded so a removed row never blocks a
		// genuinely new resource that reuses the locator.
		yield* sql`
			CREATE UNIQUE INDEX sandbox_instance_resource_idx
			ON sandbox_instance (driver, provider_resource_id)
			WHERE provider_resource_id IS NOT NULL AND status != 'removed'
		`;

		yield* sql`
			CREATE TABLE project (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;

		// Nullable, NULL = the host. RESTRICT, not CASCADE: destroying
		// infrastructure tombstones the sandbox row rather than deleting it, so
		// history keeps a valid reference. The FK is skipped on NULL, so a host
		// directory can be written before any namespace is registered.
		yield* sql`
			CREATE TABLE project_directory (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES project(id) ON UPDATE CASCADE ON DELETE CASCADE,
				directory TEXT NOT NULL,
				type TEXT NOT NULL,
				sandbox_instance_id TEXT
					REFERENCES sandbox_instance(id) ON UPDATE CASCADE ON DELETE RESTRICT
					CHECK (sandbox_instance_id IS NULL OR sandbox_instance_id <> 'local'),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;

		// SQLite treats NULLs as distinct in a unique index, so (project, NULL,
		// '/repo') would insert twice. Coalescing to the reserved id makes the
		// index read as what it means.
		yield* sql`
			CREATE UNIQUE INDEX project_directory_project_directory_idx
			ON project_directory (project_id, COALESCE(sandbox_instance_id, 'local'), directory)
		`;

		yield* sql`
			CREATE TABLE session (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES project(id) ON UPDATE CASCADE ON DELETE CASCADE,
				parent_id TEXT REFERENCES session(id) ON UPDATE CASCADE ON DELETE SET NULL,
				slug TEXT NOT NULL,
				directory TEXT NOT NULL,
				title TEXT NOT NULL,
				tag TEXT,
				metadata TEXT,
				sandbox_instance_id TEXT
					REFERENCES sandbox_instance(id) ON UPDATE CASCADE ON DELETE RESTRICT
					CHECK (sandbox_instance_id IS NULL OR sandbox_instance_id <> 'local'),
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

		yield* sql`
			CREATE TABLE session_input (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES session(id) ON UPDATE CASCADE ON DELETE CASCADE,
				prompt TEXT NOT NULL,
				delivery TEXT NOT NULL,
				admitted_seq INTEGER NOT NULL,
				promoted_seq INTEGER,
				created_at INTEGER NOT NULL
			)
		`;

		// Pending lanes are selected by session and delivery, then drained in
		// admission order. SQLite indexes NULL values, so promoted_seq IS NULL
		// uses this index for pending-input queries.
		yield* sql`
			CREATE INDEX session_input_pending_idx
			ON session_input (session_id, promoted_seq, delivery, admitted_seq)
		`;
		yield* sql`
			CREATE UNIQUE INDEX session_input_admitted_seq_idx
			ON session_input (session_id, admitted_seq)
		`;
		yield* sql`
			CREATE UNIQUE INDEX session_input_promoted_seq_idx
			ON session_input (session_id, promoted_seq)
		`;
	}),
};
