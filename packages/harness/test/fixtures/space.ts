import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ProjectSchema } from "../../src/project/schema.ts";
import { SandboxInstance } from "../../src/sandbox/instance.ts";
import { AbsolutePath } from "../../src/schema.ts";
import type { SpaceSchema } from "../../src/space/schema.ts";
import { Space } from "../../src/space/space.ts";

export interface SeedSpaceOptions {
	readonly location?: string;
	readonly env?: SandboxInstance.ID;
	readonly projectId?: string;
	readonly kind?: SpaceSchema.Kind;
}

export interface SeededSpace {
	readonly spaceId: SpaceSchema.ID;
	readonly projectId: ProjectSchema.ID;
	readonly location: AbsolutePath;
	readonly env: SandboxInstance.ID;
}

/**
 * A session row needs a space row, which needs a project row. Write both with
 * raw SQL so store tests stay about the store and not about resolution. Ids are
 * deterministic (`Space.id`), so re-seeding the same place is a no-op.
 */
export const seedSpace = Effect.fn("seedSpace")(function* (options: SeedSpaceOptions = {}) {
	const sql = yield* SqlClient.SqlClient;
	const location = AbsolutePath.make(options.location ?? "/repo");
	const env = options.env ?? SandboxInstance.ID.local;
	const projectId = ProjectSchema.ID.make(options.projectId ?? "local");
	const spaceId = Space.id(env, location);
	yield* sql`
		INSERT OR IGNORE INTO project (id, name, status, created_at, updated_at)
		VALUES (${projectId}, ${projectId}, 'active', 0, 0)
	`;
	yield* sql`
		INSERT OR IGNORE INTO space (id, project_id, location, kind, env, status, created_at, updated_at)
		VALUES (${spaceId}, ${projectId}, ${location}, ${options.kind ?? "plain"}, ${SandboxInstance.toColumn(env)}, 'active', 0, 0)
	`;
	const seeded: SeededSpace = { spaceId, projectId, location, env };
	return seeded;
});
