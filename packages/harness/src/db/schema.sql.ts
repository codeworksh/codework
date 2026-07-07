import { Schema } from "effect";
import { Model } from "effect/unstable/schema";
import { AbsolutePath } from "../schema";

// DateTime fields encoded as millisecond integers; filled with the current
// time on insert (createdAt) and on every insert/update (updatedAt).
export const Timestamps = {
	createdAt: Model.DateTimeInsertFromNumber,
	updatedAt: Model.DateTimeUpdateFromNumber,
};

const Metadata = Schema.Record(Schema.String, Schema.String);

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

export class SessionRow extends Model.Class<SessionRow>("SessionRow")({
	id: Schema.String,
	projectId: Schema.String,
	parentId: Model.FieldOption(Schema.String),
	slug: Schema.String,
	directory: AbsolutePath,
	title: Schema.String,
	tag: Schema.String,
	metadata: Model.FieldOption(Model.JsonFromString(Metadata)),
	...Timestamps,
}) {}
