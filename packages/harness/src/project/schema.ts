import { Schema } from "effect";
import { SandboxInstance } from "../sandbox/instance.ts";
import { AbsolutePath, withStatics } from "../schema.ts";

// Represents the project ID type
// defaults to local
export const ID = Schema.String.pipe(
	Schema.brand("Project.ID"),
	withStatics((schema) => ({
		local: schema.make("local"),
	})),
);
export type ID = typeof ID.Type;

// Represents identified vcs type and path
// Example:
// ```
// {
//  store: "/app/code/.git",
//  type: "git"
// }
// ```
export const Vcs = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("git"),
		store: AbsolutePath,
	}),
]);
export type Vcs = typeof Vcs.Type;

export const DirectoriesInput = Schema.Struct({
	projectId: ID,
}).annotate({ identifier: "Project.DirectoriesInput" });
export type DirectoriesInput = typeof DirectoriesInput.Type;

export const Directories = Schema.Array(AbsolutePath).annotate({
	identifier: "Project.Directories",
});
export type Directories = typeof Directories.Type;

export const ProjectDirectory = Schema.Struct({
	directory: AbsolutePath,
	sandboxInstanceId: SandboxInstance.ID,
	type: Schema.Union([Schema.Literal("main"), Schema.Literal("root"), Schema.Literal("gitworktree")]),
});
export type ProjectDirectory = typeof ProjectDirectory.Type;

export class Info extends Schema.Class<Info>("Project.Info")({
	id: ID,
	vcs: Schema.optional(Vcs),
	name: Schema.String,
	directory: AbsolutePath,
}) {}

export * as ProjectSchema from "./schema.ts";
