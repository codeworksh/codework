import path from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, Layer, Schema } from "effect";
import { eq, inArray, and } from "../db/db";
import { Database } from "../db/db";
import { ProjectTable, ProjectDirectoryTable, type ProjectDirectory as ProjectDirectoryRow } from "../db/schema.sql";
import { FileSystem } from "../filesystem/filesystem";
import { Git } from "../git/git";
import { Sandbox } from "../sandbox/sandbox";
import { AbsolutePath, withStatics } from "../schema";
import { Hash } from "../util/hash";
import { Copy } from "./copy";

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
	directory: AbsolutePath,
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
	readonly directories: (input: DirectoriesInput) => Effect.Effect<ProjectDirectory[]>;
	readonly fromDirectory: (input: AbsolutePath) => Effect.Effect<Info>;
}

export class Service extends Context.Service<Service, Interface>()("@codework/project") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const { db } = yield* Database.Service;

		const fs = yield* FileSystem.Service;
		const git = yield* Git.Service;
		const copy = yield* Copy.Service;

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

			const validRows = yield* Effect.filter(rows, (row) => fs.exists(row.directory), { concurrency: "unbounded" });

			// clean up rows whose directory no longer exists on disk
			const valid = new Set(validRows);
			const staleIDs = rows.filter((row) => !valid.has(row)).map((row) => row.id);
			if (staleIDs.length > 0) {
				yield* db
					.delete(ProjectDirectoryTable)
					.where(inArray(ProjectDirectoryTable.id, staleIDs))
					.run()
					.pipe(Effect.orDie);
			}

			return validRows
				.toSorted((a, b) => a.directory.localeCompare(b.directory))
				.map((row) => toProjectDirectory(row));
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

		type Resolved = {
			previous?: ID;
			id: ID;
			directory: AbsolutePath;
			vcs?: Vcs;
			name: string;
		};

		const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
			const repo = yield* git.find(input);
			if (!repo) {
				const local: Resolved = {
					id: ID.local,
					directory: input,
					name: path.basename(path.normalize(input)),
				};
				return local;
			}

			const previous = yield* cached(repo.store);
			const origin = yield* remote(repo);
			const id = origin?.id ?? previous ?? (yield* root(repo));
			const resolved: Resolved = {
				id: id ?? ID.local,
				...(previous ? { previous } : {}),
				directory: repo.directory,
				vcs: { type: "git", store: repo.store },
				name: origin?.name ?? path.basename(path.normalize(repo.directory)),
			};
			return resolved;
		});

		// TODO: requires implementation
		const migrateProjectId = Effect.fn("Project.migrateProjectID")(function* (oldID: ID | undefined, newID: ID) {
			if (!oldID) return; // nothing to migrate from
			if (oldID === ID.local) return; // local project copy are ignored
			if (oldID === newID) return; // just the same
			yield* Effect.void;
		});

		const saveDirectory = Effect.fn("Project.saveDirectory")(function* (input: { projectID: ID; directory: string }) {
			if (input.projectID === ID.local) return;
			const isGitWorktree = yield* copy.isGitWorktree({
				directory: AbsolutePath.make(input.directory),
			});

			yield* db
				.transaction(
					(d) =>
						Effect.gen(function* () {
							const hasMain = yield* d
								.select({ directory: ProjectDirectoryTable.directory })
								.from(ProjectDirectoryTable)
								.where(
									and(
										eq(ProjectDirectoryTable.projectId, input.projectID),
										eq(ProjectDirectoryTable.type, "main"),
									),
								)
								.get();

							yield* d
								.insert(ProjectDirectoryTable)
								.values({
									id: Hash.fast(`${input.projectID}:${input.directory}`),
									projectId: input.projectID,
									directory: input.directory,
									type: isGitWorktree ? "gitworktree" : hasMain ? "root" : "main",
									sandboxEnvID: "@codework/envDefault",
								})
								.onConflictDoNothing()
								.run();
						}),
					{ behavior: "immediate" },
				)
				.pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() =>
							console.warn("project directory persistence failed", {
								projectID: input.projectID,
								cause,
							}),
						),
					),
				);
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

			const existing = row
				? {
						id: row.id,
						name: row.name,
						createdAt: row.createdAt,
					}
				: {
						id: projectID,
						name: data.name,
						createdAt: Date.now(),
					};

			const upsert = {
				...existing,
				updatedAt: Date.now(),
			};

			yield* db
				.insert(ProjectTable)
				.values({
					id: upsert.id,
					name: upsert.name,
					createdAt: upsert.createdAt,
					updatedAt: upsert.updatedAt,
				})
				.onConflictDoUpdate({
					target: ProjectTable.id,
					set: { updatedAt: upsert.updatedAt },
				})
				.run()
				.pipe(Effect.orDie);

			yield* saveDirectory({ projectID, directory: data.directory });

			const result: Info = {
				id: ID.make(upsert.id),
				name: upsert.name,
				vcs: data.vcs ?? undefined,
				directory: data.directory,
			};

			return result;
		});

		return Service.of({ resolve, directories, fromDirectory });
	}),
);

export const layerWith = <E, RIn>(sandbox: Sandbox.Sandbox<E, RIn>) =>
	layer.pipe(
		Layer.provide(Git.layer),
		Layer.provide(Copy.layer),
		Layer.provide(Sandbox.filesystem(sandbox)),
		Layer.provide(NodeServices.layer),
		Layer.provide(Database.defaultLayer),
	);

export const defaultLayer = (path: string) => layerWith(Sandbox.EnvDefault.layer(path));

export * as Project from "./project";
