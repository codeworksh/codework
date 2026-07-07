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
	}),
};
