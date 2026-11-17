import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Migrations ship as code (Migrator.fromRecord), keyed "YYYYMMDD<2-digit counter>_<label>": ten digits,
// because Postgres stores the id as a 32-bit integer. Only the numeric prefix orders them, and it must be
// greater than every id already applied.
export const migrations = {
	"2026111701_identity": Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`CREATE EXTENSION IF NOT EXISTS citext`;

		// One row per person, keyed by the auth vendor's subject so a vendor switch migrates users only.
		yield* sql`
			CREATE TABLE account (
				id         uuid PRIMARY KEY DEFAULT uuidv7(),
				auth_id    text NOT NULL UNIQUE,
				email      citext NOT NULL UNIQUE,
				name       text,
				created_at timestamptz NOT NULL DEFAULT now()
			)
		`;
		yield* sql`
			CREATE TABLE workspace (
				id         uuid PRIMARY KEY DEFAULT uuidv7(),
				name       text NOT NULL,
				created_by uuid NOT NULL REFERENCES account(id),
				created_at timestamptz NOT NULL DEFAULT now()
			)
		`;
		yield* sql`
			CREATE TABLE member (
				workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
				account_id   uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
				role         text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
				created_at   timestamptz NOT NULL DEFAULT now(),
				PRIMARY KEY (workspace_id, account_id)
			)
		`;
		yield* sql`CREATE INDEX member_account ON member (account_id)`;
	}),
};
