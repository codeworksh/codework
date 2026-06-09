import { Schema, Effect, Context, Layer } from "effect";
import { withStatics } from "../schema";
import { AbsolutePath } from "../schema";
// import { Database } from "../db/db";
// import { FileSystem } from "../filesystem/filesystem";

export const ID = Schema.String.pipe(
	Schema.brand("Project.ID"),
	withStatics((schema) => ({
		local: schema.make("local"),
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
			previous?: ID; // previous ID before moving
			id: ID; // current ID
			directory: AbsolutePath;
			vcs?: Vcs;
			name: string;
		},
		never
	>;
}

export class Service extends Context.Service<Service, Interface>()("@codework/project") {}

export const layer = Layer.effect(
	Service,
	// Effect.gen(function* () {
	// 	const { db } = yield* Database.Service;
	// 	const fs = yield* FileSystem.Service;
	// }),
);
