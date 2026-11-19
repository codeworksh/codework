import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Migrations ship as code (Migrator.fromRecord), keyed "YYYYMMDD<2-digit counter>_<label>": ten digits,
// because Postgres stores the id as a 32-bit integer. Only the numeric prefix orders them, and it must be
// greater than every id already applied.
export const migrations = {
	"2026111701_identity": Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;

		// One row per person, keyed by the auth vendor's subject so a vendor switch migrates users only.
		// Email and name are for display: a new subject may arrive with an email the relay has seen.
		yield* sql`
			CREATE TABLE account (
				id         uuid PRIMARY KEY DEFAULT uuidv7(),
				auth_id    text NOT NULL UNIQUE,
				email      text NOT NULL,
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
		// workspaces is N rows, and the key's thumbprint (key_id) finds exactly one of them. The home's
		// identity key vouched for that key at pairing: rows sharing identity_key_id are one machine.
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
				identity_key_id text NOT NULL,
				last_seen_at    timestamptz,
				created_at      timestamptz NOT NULL DEFAULT now(),
				revoked_at      timestamptz,
				PRIMARY KEY (workspace_id, id)
			)
		`;
		// A connect in flight. The machine's key is registered with the code and signs every poll, so only
		// the process that holds it can see the outcome. Approval marks the row; the machine's next signed
		// poll activates the link, so a key nobody holds anymore never replaces a working one. seen_at is
		// the poll's lease: a connect that stopped polling drops out of Waiting to Join and can't be approved.
		yield* sql`
			CREATE TABLE pairing (
				id           uuid PRIMARY KEY DEFAULT uuidv7(),
				user_code    text NOT NULL UNIQUE,
				workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
				machine      jsonb NOT NULL,
				key          jsonb NOT NULL,
				key_id       text NOT NULL UNIQUE,
				identity_key_id text NOT NULL,
				status       text NOT NULL CHECK (status IN ('pending', 'approved', 'active', 'declined', 'superseded')),
				approved_by  uuid REFERENCES account(id),
				connected    jsonb,
				seen_at      timestamptz NOT NULL DEFAULT now(),
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
};
