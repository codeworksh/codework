import path from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { eq } from "../db/db";
import { Database } from "../db/db";
import {
	ProjectTable,
	ProjectDirectoryTable,
	type Project as ProjectRow,
	type ProjectDirectory as ProjectDirectoryRow,
} from "../db/schema.sql";
import { FileSystem } from "../filesystem/filesystem";
import { Git } from "../git";
import { AbsolutePath, withStatics } from "../schema";
import { Hash } from "../util/hash";

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
	projectID: ID,
}).annotate({ identifier: "Project.DirectoriesInput" });
export type DirectoriesInput = typeof DirectoriesInput.Type;

export const Directories = Schema.Array(AbsolutePath).annotate({
	identifier: "Project.Directories",
});
export type Directories = typeof Directories.Type;

export const ProjectDirectory = Schema.Struct({
	directory: AbsolutePath,
	sandboxEnvID: Schema.String,
	type: Schema.Union([Schema.Literal("main"), Schema.Literal("root"), Schema.Literal("gitworktree")]),
});
export type ProjectDirectory = typeof ProjectDirectory.Type;

export class Info extends Schema.Class<Info>("Project.Info")({
	id: ID,
	vcs: Schema.optional(Vcs),
	name: Schema.String,
	directory: ProjectDirectory,
	directories: Schema.Array(ProjectDirectory),
}) {}

export interface Interface {
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
	readonly fromDirectory: (input: AbsolutePath) => Effect.Effect<Info>;
}

export class Service extends Context.Service<Service, Interface>()("@codework/project") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const { db } = yield* Database.Service;

		const fs = yield* FileSystem.Service;
		const git = yield* Git.Service;

		const toProjectDirectory = (row: ProjectDirectoryRow): ProjectDirectory => {
			return {
				directory: AbsolutePath.make(row.directory),
				sandboxEnvID: row.sandboxEnvID,
				type: row.type,
			};
		};

		const directories = Effect.fn("Project.directories")(function* (input: DirectoriesInput) {
			const rows = yield* db
				.select()
				.from(ProjectDirectoryTable)
				.where(eq(ProjectDirectoryTable.projectId, input.projectID))
				.all()
				.pipe(Effect.orDie);

			return rows.toSorted((a, b) => a.directory.localeCompare(b.directory)).map((row) => toProjectDirectory(row));
		});

		const cached = Effect.fnUntraced(function* (dir: string) {
			return yield* fs.readFileString(path.join(dir, "codework")).pipe(
				Effect.map((value) => value.trim()),
				Effect.map((value) => (value ? ID.make(value) : undefined)),
				Effect.catch(() => Effect.void),
			);
		});

		const remote = Effect.fnUntraced(function* (repo: Git.Repo) {
			const origin = yield* git.remote(repo);
			if (!origin) return undefined;
			const normalized = url(origin);
			if (!normalized) return undefined;
			return {
				id: ID.make(Hash.fast(`git:${normalized}`)),
				name: path.posix.basename(normalized),
			};
		});

		function url(input: string) {
			const value = input.trim();
			if (!value) return undefined;

			try {
				const parsed = new URL(value);
				if (parsed.protocol === "file:") return undefined;
				return parts(parsed.hostname, parsed.pathname);
			} catch {
				const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/);
				if (scp) return parts(scp[2]!, scp[3]!);
				return undefined;
			}
		}

		function parts(host: string, name: string) {
			const pathname = name
				.replace(/^\/+/, "")
				.replace(/\.git\/?$/, "")
				.replace(/\/+$/, "");
			if (!host || !pathname) return undefined;
			return `${host.toLowerCase()}/${pathname}`;
		}

		const root = Effect.fnUntraced(function* (repo: Git.Repo) {
			const root = (yield* git.roots(repo))[0];
			return root ? ID.make(root) : undefined;
		});

		const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
			const repo = yield* git.find(input);
			if (!repo) {
				return {
					previous: undefined,
					id: ID.local,
					directory: input,
					name: path.basename(path.normalize(input)),
					vcs: undefined,
				};
			}

			const previous = yield* cached(repo.store);
			const origin = yield* remote(repo);
			const id = origin?.id ?? previous ?? (yield* root(repo));
			return {
				id: id ?? ID.local,
				previous: previous ?? undefined,
				directory: repo.directory,
				vcs: { type: "git" as const, store: repo.store },
				name: origin?.name ?? path.basename(path.normalize(repo.directory)),
			};
		});

		const migrateProjectId = Effect.fn("Project.migrateProjectID")(function* (oldID: ID | undefined, newID: ID) {
			if (!oldID) return; // nothing to migrate from
			if (oldID === ID.local) return; // local project copy are ignored
			if (oldID === newID) return; // just the same
			// TODO: run a database query to migrate old ID to new one for the ProjectTable
		});

		const fromDirectory = Effect.fn("Project.fromDirectory")(function* (directory: string) {
			const data = yield* resolve(AbsolutePath.make(directory));
			const projectID = ID.make(data.id);

			// conditionally migrates previous cached projectID to new one
			yield* migrateProjectId(data.previous ? ID.make(data.previous) : undefined, projectID);

			const row = yield* db
				.select()
				.from(ProjectTable)
				.where(eq(ProjectTable.id, projectID))
				.get()
				.pipe(Effect.orDie);
		});

		return Service.of({ resolve, fromDirectory });
	}),
);

export const defaultLayer = (path: string) =>
	layer.pipe(
		Layer.provide(FileSystem.defaultLayer(path)),
		Layer.provide(Git.defaultLayer(path)),
		Layer.provide(Database.defaultLayer),
	);

export * as Project from "./project";
