import { Schema } from "effect";
import { RepoSchema } from "./repo.ts";

// Env-independent project id: marker ?? remoteHash ?? rootCommit ?? provisional.
export const ID = Schema.String.pipe(Schema.brand("Project.ID"));
export type ID = typeof ID.Type;

// A project is archived, never deleted, once it has no active space anywhere.
export const Status = Schema.Literals(["active", "archived"]);
export type Status = typeof Status.Type;

export class Info extends Schema.Class<Info>("Project.Info")({
	id: ID,
	name: Schema.String,
	status: Status,
	vcs: Schema.optional(RepoSchema.Vcs),
}) {}

export * as ProjectSchema from "./project.ts";
