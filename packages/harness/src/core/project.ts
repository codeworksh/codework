import { Schema, Effect } from "effect";
import { withStatics } from "../schema";
import { AbsolutePath } from "../schema";

export const ID = Schema.String.pipe(
	Schema.brand("Project.ID"),
	withStatics((schema) => ({
		global: schema.make("global"),
	})),
);
export type ID = typeof ID.Type;

export const Vcs = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("git"),
		store: AbsolutePath,
	}),
]);
export type Vcs = typeof Vcs.Type;

export class Info extends Schema.Class<Info>("Project.Info")({
	id: ID,
}) {}

export const DirectoriesInput = Schema.Struct({
	projectID: ID,
}).annotate({ identifier: "Project.DirectoriesInput" });
export type DirectoriesInput = typeof DirectoriesInput.Type;

export const Directories = Schema.Array(AbsolutePath).annotate({ identifier: "Project.Directories" });
export type Directories = typeof Directories.Type;

export interface Interface {
	readonly directories: (input: DirectoriesInput) => Effect.Effect<Directories>;
	readonly resolve: (input: AbsolutePath) => Effect.Effect<
		{
			previous?: ID;
			id: ID;
			directory: AbsolutePath;
			vcs?: Vcs;
		},
		never
	>;
}
