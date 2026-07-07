import { Schema } from "effect";
import { Model } from "effect/unstable/schema";

// DateTime fields encoded as millisecond integers; filled with the current
// time on insert (createdAt) and on every insert/update (updatedAt).
export const Timestamps = {
	createdAt: Model.DateTimeInsertFromNumber,
	updatedAt: Model.DateTimeUpdateFromNumber,
};

// Column names derive from field names via the client's camelToSnake
// transform, so `sandboxEnvId` (not `sandboxEnvID`) maps to `sandbox_env_id`.
export class ProjectRow extends Model.Class<ProjectRow>("ProjectRow")({
	id: Schema.String,
	name: Schema.String,
	...Timestamps,
}) {}

export class ProjectDirectoryRow extends Model.Class<ProjectDirectoryRow>("ProjectDirectoryRow")({
	id: Schema.String,
	projectId: Schema.String,
	directory: Schema.String,
	type: Schema.Literals(["main", "root", "gitworktree"]),
	sandboxEnvId: Schema.String,
	...Timestamps,
}) {}
