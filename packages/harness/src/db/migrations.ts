import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Migrations ship as code (Migrator.fromRecord) rather than .sql files on
// disk, so they survive bundling and need no runtime path resolution.
//
// Keys are "YYYYMMDD<counter>_<label>" (4-digit counter, several per day);
// fromRecord requires the "_<label>" suffix and silently drops keys without
// it. Only the numeric prefix orders migrations, and it must be strictly
// greater than every id already applied — the migrator runs by high-water
// mark, so an id dated before an applied one is silently skipped.
//
// The thread model replaced every earlier migration: databases created before it are discarded,
// not upgraded, so this one assumes an empty database.
export const migrations = {
	"202610290001_init": Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;

		// Head of one aggregate's log (aggregate = session), and who holds it.
		yield* sql`
			CREATE TABLE sequence (
				aggregate_id TEXT PRIMARY KEY,
				seq          INTEGER NOT NULL,
				owner_id     TEXT
			)
		`;

		// The durable log. Seq is contiguous per aggregate, from 1.
		yield* sql`
			CREATE TABLE event (
				id           TEXT PRIMARY KEY,
				aggregate_id TEXT NOT NULL REFERENCES sequence(aggregate_id) ON DELETE CASCADE,
				seq          INTEGER NOT NULL,
				type         TEXT NOT NULL,
				data         TEXT NOT NULL
			)
		`;
		yield* sql`CREATE UNIQUE INDEX event_seq_idx ON event (aggregate_id, seq)`;
		yield* sql`CREATE INDEX event_type_idx ON event (aggregate_id, type, seq)`;

		// A provisioned filesystem namespace. The host is never a row: NULL is its storage form.
		yield* sql`
			CREATE TABLE sandbox (
				id                   TEXT PRIMARY KEY CHECK (id <> 'local'),
				driver               TEXT NOT NULL,
				kind                 TEXT NOT NULL,
				provider_resource_id TEXT,
				runtime_config       TEXT,
				ownership            TEXT NOT NULL,
				status               TEXT NOT NULL,
				provider_status      TEXT,
				state_observed_at    INTEGER NOT NULL,
				metadata             TEXT,
				last_error           TEXT,
				last_mounted_at      INTEGER,
				last_unmounted_at    INTEGER,
				last_used_at         INTEGER,
				removed_at           INTEGER,
				created_at           INTEGER NOT NULL,
				updated_at           INTEGER NOT NULL
			)
		`;
		// One live row per driver resource; tombstones excluded.
		yield* sql`
			CREATE UNIQUE INDEX sandbox_resource_idx ON sandbox (driver, provider_resource_id)
			WHERE provider_resource_id IS NOT NULL AND status <> 'removed'
		`;

		// A logical codebase, env-independent. Archived, never deleted.
		yield* sql`
			CREATE TABLE project (
				id         TEXT PRIMARY KEY,
				name       TEXT NOT NULL,
				status     TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;

		// One directory in one env. id = hash(env | 'local', location).
		yield* sql`
			CREATE TABLE space (
				id         TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
				location   TEXT NOT NULL,
				kind       TEXT NOT NULL,
				env        TEXT REFERENCES sandbox(id) ON DELETE RESTRICT CHECK (env IS NULL OR env <> 'local'),
				status     TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;
		yield* sql`CREATE UNIQUE INDEX space_location_idx ON space (coalesce(env, 'local'), location)`;
		yield* sql`
			CREATE UNIQUE INDEX space_primary_idx ON space (project_id, coalesce(env, 'local')) WHERE kind = 'primary'
		`;
		yield* sql`CREATE INDEX space_project_idx ON space (project_id)`;

		yield* sql`
			CREATE TABLE session (
				id         TEXT PRIMARY KEY,
				space_id   TEXT NOT NULL REFERENCES space(id) ON DELETE RESTRICT,
				slug       TEXT NOT NULL,
				directory  TEXT NOT NULL,
				host_dir   TEXT,
				tag        TEXT,
				metadata   TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;
		yield* sql`CREATE UNIQUE INDEX session_slug_idx ON session (slug)`;
		yield* sql`CREATE INDEX session_space_idx ON session (space_id)`;
		yield* sql`CREATE INDEX session_tag_idx ON session (tag)`;

		yield* sql`
			CREATE TABLE thread (
				id                 TEXT PRIMARY KEY,
				session_id         TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
				origin_kind        TEXT NOT NULL,
				origin_thread_id   TEXT,
				origin_entry_id    TEXT,
				origin_call_id     TEXT,
				title              TEXT,
				execution          TEXT,
				restarts           INTEGER NOT NULL DEFAULT 0,
				cost               REAL NOT NULL DEFAULT 0,
				tokens_input       INTEGER NOT NULL DEFAULT 0,
				tokens_output      INTEGER NOT NULL DEFAULT 0,
				tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
				tokens_cache_write INTEGER NOT NULL DEFAULT 0,
				created_seq        INTEGER NOT NULL,
				created_at         INTEGER NOT NULL,
				updated_at         INTEGER NOT NULL,
				UNIQUE (session_id, id),
				-- the source thread lives in the same session
				FOREIGN KEY (session_id, origin_thread_id) REFERENCES thread(session_id, id),
				-- the fork point lives in the source thread
				FOREIGN KEY (origin_thread_id, origin_entry_id) REFERENCES entry(thread_id, id),
				-- main is the only root: the context walk ends there, thread_main_idx counts it
				CHECK ((origin_kind = 'main') = (origin_thread_id IS NULL)),
				-- a fork always has a cut; without it the context walk silently returns nothing
				CHECK (origin_kind <> 'fork' OR origin_entry_id IS NOT NULL),
				-- exactly the subagents carry a call
				CHECK ((origin_kind = 'subagent') = (origin_call_id IS NOT NULL))
			)
		`;
		yield* sql`CREATE UNIQUE INDEX thread_main_idx ON thread (session_id) WHERE origin_kind = 'main'`;
		yield* sql`CREATE INDEX thread_origin_idx ON thread (origin_thread_id) WHERE origin_thread_id IS NOT NULL`;
		// Call ids are unique per entry, not globally: one subagent per call of a thread.
		yield* sql`
			CREATE UNIQUE INDEX thread_call_idx ON thread (origin_thread_id, origin_call_id)
			WHERE origin_call_id IS NOT NULL
		`;
		yield* sql`CREATE INDEX thread_running_idx ON thread (session_id) WHERE execution = 'running'`;

		yield* sql`
			CREATE TABLE entry (
				id            TEXT PRIMARY KEY,
				session_id    TEXT NOT NULL,
				thread_id     TEXT NOT NULL,
				seq           INTEGER NOT NULL,
				committed_seq INTEGER,
				type          TEXT NOT NULL,
				state         TEXT NOT NULL,
				data          TEXT NOT NULL,
				label         TEXT,
				metadata      TEXT,
				created_at    INTEGER NOT NULL,
				updated_at    INTEGER NOT NULL,
				UNIQUE (thread_id, id),
				FOREIGN KEY (session_id, thread_id) REFERENCES thread(session_id, id) ON DELETE CASCADE,
				-- the fork cut reads committed_seq: set exactly when the entry stops changing
				CHECK ((state = 'draft') = (committed_seq IS NULL)),
				CHECK (committed_seq IS NULL OR committed_seq >= seq)
			)
		`;
		yield* sql`CREATE INDEX entry_seq_idx ON entry (session_id, seq)`;
		// One entry per thread per event: seq alone orders a thread, and a cut at a seq is exact.
		yield* sql`CREATE UNIQUE INDEX entry_thread_idx ON entry (thread_id, seq)`;
		yield* sql`CREATE INDEX entry_type_idx ON entry (thread_id, type, seq)`;
		yield* sql`CREATE INDEX entry_draft_idx ON entry (thread_id) WHERE state = 'draft'`;
		yield* sql`CREATE INDEX entry_label_idx ON entry (thread_id, seq) WHERE label IS NOT NULL`;

		yield* sql`
			CREATE TABLE part (
				id         TEXT PRIMARY KEY,
				entry_id   TEXT NOT NULL,
				thread_id  TEXT NOT NULL,
				part_index INTEGER NOT NULL,
				type       TEXT NOT NULL,
				status     TEXT,
				call_id    TEXT,
				tool_name  TEXT,
				data       TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (thread_id, entry_id) REFERENCES entry(thread_id, id) ON DELETE CASCADE
			)
		`;
		yield* sql`CREATE UNIQUE INDEX part_index_idx ON part (entry_id, part_index)`;
		yield* sql`CREATE UNIQUE INDEX part_call_idx ON part (entry_id, call_id) WHERE call_id IS NOT NULL`;
		yield* sql`CREATE INDEX part_call_lookup_idx ON part (thread_id, call_id) WHERE call_id IS NOT NULL`;
		yield* sql`
			CREATE INDEX part_unsettled_idx ON part (thread_id, status) WHERE status IN ('pending', 'running')
		`;

		yield* sql`
			CREATE TABLE inbox (
				id            TEXT PRIMARY KEY,
				session_id    TEXT NOT NULL,
				thread_id     TEXT NOT NULL,
				kind          TEXT NOT NULL,
				data          TEXT NOT NULL,
				delivery      TEXT NOT NULL,
				admitted_seq  INTEGER NOT NULL,
				promoted_seq  INTEGER,
				cancelled_seq INTEGER,
				created_at    INTEGER NOT NULL,
				FOREIGN KEY (session_id, thread_id) REFERENCES thread(session_id, id) ON DELETE CASCADE
			)
		`;
		yield* sql`CREATE UNIQUE INDEX inbox_admitted_idx ON inbox (session_id, admitted_seq)`;
		yield* sql`CREATE UNIQUE INDEX inbox_promoted_idx ON inbox (session_id, promoted_seq)`;
		// Pending lanes per thread, drained in admission order.
		yield* sql`CREATE INDEX inbox_pending_idx ON inbox (thread_id, promoted_seq, delivery, admitted_seq)`;

		yield* sql`
			CREATE TABLE document (
				id          TEXT PRIMARY KEY,
				session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
				thread_id   TEXT,
				kind        TEXT NOT NULL,
				history     TEXT,
				fork        TEXT,
				created_seq INTEGER NOT NULL,
				retired_seq INTEGER,
				FOREIGN KEY (session_id, thread_id) REFERENCES thread(session_id, id) ON DELETE CASCADE
			)
		`;
		// One live document per kind and scope.
		yield* sql`
			CREATE UNIQUE INDEX document_live_idx ON document (session_id, coalesce(thread_id, ''), kind)
			WHERE retired_seq IS NULL
		`;

		yield* sql`
			CREATE TABLE revision (
				document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
				seq         INTEGER NOT NULL,
				version     INTEGER NOT NULL,
				value       TEXT NOT NULL,
				PRIMARY KEY (document_id, seq)
			)
		`;
	}),
};
