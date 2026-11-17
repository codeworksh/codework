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

	"2026111702_machines": Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;

		// A machine's link to one workspace. Each link has its own key, so one home connected to N
		// workspaces is N rows, and the key's thumbprint (key_id) finds exactly one of them.
		yield* sql`
			CREATE TABLE machine (
				workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
				id              text NOT NULL,
				source          text NOT NULL CHECK (source IN ('generated', 'flag')),
				local_host_name text NOT NULL,
				given_name      text,
				os              text NOT NULL,
				arch            text NOT NULL,
				version         text NOT NULL,
				owner_id        uuid NOT NULL REFERENCES account(id),
				key             jsonb NOT NULL,
				key_id          text NOT NULL UNIQUE,
				last_seen_at    timestamptz,
				created_at      timestamptz NOT NULL DEFAULT now(),
				revoked_at      timestamptz,
				PRIMARY KEY (workspace_id, id)
			)
		`;
		// A pending connect: the machine's key is registered when the code is created, so a leaked device
		// code is useless without the private key.
		yield* sql`
			CREATE TABLE pairing (
				id           uuid PRIMARY KEY DEFAULT uuidv7(),
				code_hash    text NOT NULL UNIQUE,
				user_code    text NOT NULL UNIQUE,
				workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
				machine      jsonb NOT NULL,
				key          jsonb NOT NULL,
				key_id       text NOT NULL,
				status       text NOT NULL CHECK (status IN ('pending', 'approved')),
				approved_by  uuid REFERENCES account(id),
				connected    jsonb,
				expires_at   timestamptz NOT NULL,
				created_at   timestamptz NOT NULL DEFAULT now()
			)
		`;
		// Signed requests that change state carry a jti accepted once, across every relay instance.
		yield* sql`
			CREATE TABLE assertion (
				jti        text PRIMARY KEY,
				expires_at timestamptz NOT NULL
			)
		`;
	}),

	"2026111801_declined": Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			ALTER TABLE pairing DROP CONSTRAINT pairing_status_check,
				ADD CONSTRAINT pairing_status_check CHECK (status IN ('pending', 'approved', 'declined'))
		`;
	}),
};
