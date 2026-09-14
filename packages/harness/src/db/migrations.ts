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

		// Tracks head of the inbox event sequence for a given aggregate.
		yield* sql`
			CREATE TABLE event_sequence (
				aggregate_id TEXT PRIMARY KEY,
				seq INTEGER NOT NULL,
				owner_id TEXT
			)
		`;

		// A durable inbox event store. An event is then picked and processed.
		// Stores countigous sequence of events for a given aggregate.
		yield* sql`
			CREATE TABLE event (
				id TEXT PRIMARY KEY,
				aggregate_id TEXT NOT NULL
					REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
				seq INTEGER NOT NULL,
				type TEXT NOT NULL,
				data TEXT NOT NULL
			)
		`;

		yield* sql`CREATE UNIQUE INDEX event_aggregate_id_seq_idx ON event (aggregate_id, seq)`;
		yield* sql`CREATE INDEX event_aggregate_id_type_seq_idx ON event (aggregate_id, type, seq)`;

		// A durable filesystem namespace. Created before space because it
		// references it. Reference counts are deliberately
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

		// A logical codebase, env-independent. Archived rather than deleted once
		// it has no active space anywhere, so session history stays reachable.
		yield* sql`
			CREATE TABLE project (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;

		// One directory in one env. `id` is Hash.fast([env|'local', location]) —
		// no project component, so re-pointing a space to another project keeps
		// every session key intact. `env` NULL = host (same convention as
		// sandbox_instance_id everywhere else); the FK is skipped on NULL.
		// RESTRICT on both FKs: a space with sessions is archived, never deleted,
		// and a destroyed sandbox is tombstoned, not removed.
		yield* sql`
			CREATE TABLE space (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES project(id) ON UPDATE CASCADE ON DELETE RESTRICT,
				location TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('primary', 'linked', 'copy', 'plain')),
				env TEXT
					REFERENCES sandbox_instance(id) ON UPDATE CASCADE ON DELETE RESTRICT
					CHECK (env IS NULL OR env <> 'local'),
				status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;

		// One place, one row. SQLite treats NULLs as distinct in a unique index,
		// so (NULL, '/repo') would insert twice; coalescing to the reserved id
		// makes the index read as what it means.
		yield* sql`
			CREATE UNIQUE INDEX space_location_idx
			ON space (COALESCE(env, 'local'), location)
		`;

		// Exactly one primary per (project, env). Partial: the other kinds are
		// unbounded. Status is deliberately not part of the predicate — an
		// archived primary must be demoted before another can be promoted.
		yield* sql`
			CREATE UNIQUE INDEX space_primary_idx
			ON space (project_id, COALESCE(env, 'local')) WHERE kind = 'primary'
		`;

		yield* sql`CREATE INDEX space_project_idx ON space (project_id)`;

		// A session belongs to a space; project and env are derived through it,
		// never denormalised here. `directory` is the ABSOLUTE realpath of the
		// session cwd, always equal to or under space.location (which is immutable).
		// RESTRICT: sessions are history, a referenced space cannot go away.
		yield* sql`
			CREATE TABLE session (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL REFERENCES space(id) ON UPDATE CASCADE ON DELETE RESTRICT,
				parent_id TEXT REFERENCES session(id) ON UPDATE CASCADE ON DELETE SET NULL,
				slug TEXT NOT NULL,
				directory TEXT NOT NULL,
				title TEXT NOT NULL,
				tag TEXT,
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

		yield* sql`CREATE INDEX session_space_idx ON session (space_id)`;
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
				state TEXT NOT NULL DEFAULT 'committed'
					CHECK (state IN ('draft', 'committed', 'aborted')),
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
		yield* sql`CREATE INDEX session_entry_state_idx ON session_entry (session_id, state, seq)`;
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
