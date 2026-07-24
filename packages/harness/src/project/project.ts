import { Context, Effect, Layer, Option, Schema } from "effect";
import { Model } from "effect/unstable/schema";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { posix as path } from "node:path";
import { Database } from "../db/db";
import { ProjectDirectoryRow, ProjectRow } from "../db/schema.sql";
import { SandboxEnv } from "../sandbox/env";
import { SandboxInstance } from "../sandbox/instance";
import { SandboxFileSystem } from "../sandbox/filesystem/filesystem";
import { Git } from "../git/git";
import { Sandbox } from "../sandbox/sandbox";
import { AbsolutePath } from "../schema";
import { Hash } from "../util/hash";
import { ProjectCopy } from "./copy";
import { ProjectSchema } from "./schema";

/**
 * Row identity for a registered directory. Keyed on the environment as well as
 * the path: `/workspace` in two different sandboxes is two different places,
 * and hashing the path alone would collapse them into one row.
 */
const directoryId = (projectId: string, sandboxInstanceId: string, directory: string) =>
	Hash.fast(JSON.stringify([projectId, sandboxInstanceId, directory]));

export interface Resolved {
	previous?: ProjectSchema.ID; // previous ID before moving
	id: ProjectSchema.ID; // current ID
	directory: AbsolutePath;
	vcs?: ProjectSchema.Vcs;
	name: string;
}

export interface Interface {
	readonly resolve: (input: AbsolutePath) => Effect.Effect<Resolved>;
	readonly directories: (input: ProjectSchema.DirectoriesInput) => Effect.Effect<ProjectSchema.ProjectDirectory[]>;
	readonly fromDirectory: (input: AbsolutePath) => Effect.Effect<ProjectSchema.Info>;
}

export class Service extends Context.Service<Service, Interface>()("@codework/project") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;

		const fs = yield* SandboxFileSystem.Service;
		const git = yield* Git.Service;
		const copy = yield* ProjectCopy.Service;
		// Which sandbox instance these directories live in. Rows belonging to
		// another namespace are invisible here: their paths mean nothing to this
		// filesystem, so probing them would report absence and delete them.
		//
		// Transitional: the value still arrives as a raw `SandboxEnv.EnvId` and is
		// branded at this boundary. Phase 6 replaces the source with
		// `SandboxInstance.Service`, at which point the brand comes for free and
		// this cast goes away with the `SandboxEnv` import.
		const instanceId = SandboxInstance.ID.make(yield* SandboxEnv.EnvId);

		const selectDirectories = SqlSchema.findAll({
			Request: Schema.Struct({ projectId: Schema.String, sandboxInstanceId: Schema.String }),
			Result: ProjectDirectoryRow,
			execute: ({ projectId, sandboxInstanceId }) =>
				sql`SELECT * FROM project_directory WHERE project_id = ${projectId} AND sandbox_instance_id = ${sandboxInstanceId}`,
		});

		// Every environment's rows. Only for re-homing during an id migration,
		// where rows would otherwise cascade-delete with the old project — reads
		// must stay scoped to the current environment.
		const selectAllDirectories = SqlSchema.findAll({
			Request: Schema.String,
			Result: ProjectDirectoryRow,
			execute: (projectId) => sql`SELECT * FROM project_directory WHERE project_id = ${projectId}`,
		});

		const findProject = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: ProjectRow,
			execute: (id) => sql`SELECT * FROM project WHERE id = ${id}`,
		});

		const insertProject = SqlSchema.void({
			Request: ProjectRow.insert,
			execute: (row) => sql`INSERT INTO project ${sql.insert(row)}`,
		});

		// the conflict target is the primary key; only the update timestamp moves
		const upsertProject = SqlSchema.void({
			Request: ProjectRow.insert,
			execute: (row) => sql`
				INSERT INTO project ${sql.insert(row)}
				ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
			`,
		});

		// tolerates both id and (project_id, directory) conflicts
		const insertDirectory = SqlSchema.void({
			Request: ProjectDirectoryRow.insert,
			execute: (row) => sql`INSERT OR IGNORE INTO project_directory ${sql.insert(row)}`,
		});

		const toProjectDirectory = (row: ProjectDirectoryRow): ProjectSchema.ProjectDirectory => {
			return {
				directory: AbsolutePath.make(row.directory),
				sandboxInstanceId: row.sandboxInstanceId,
				type: row.type,
			};
		};

		const directories = Effect.fn("Project.directories")(function* (input: ProjectSchema.DirectoriesInput) {
			const rows = yield* selectDirectories({ projectId: input.projectId, sandboxInstanceId: instanceId }).pipe(
				Effect.orDie,
			);

			// Three-way, not two: a row is kept, dropped, or unknown. Only a
			// definitive "absent" prunes — a backend that could not answer (expired
			// token, timeout) leaves the row alone rather than destroying a record
			// we may not be able to rebuild.
			const probed = yield* Effect.forEach(
				rows,
				(row) =>
					fs.exists(row.directory).pipe(
						Effect.map((exists) => ({ row, stale: !exists })),
						Effect.orElseSucceed(() => ({ row, stale: false })),
					),
				{ concurrency: "unbounded" },
			);

			const validRows = probed.filter((entry) => !entry.stale).map((entry) => entry.row);
			const staleIDs = probed.filter((entry) => entry.stale).map((entry) => entry.row.id);
			if (staleIDs.length > 0) {
				yield* sql`DELETE FROM project_directory WHERE ${sql.in("id", staleIDs)}`.pipe(Effect.orDie);
			}

			return validRows
				.toSorted((a, b) => a.directory.localeCompare(b.directory))
				.map((row) => toProjectDirectory(row));
		});

		const cached = Effect.fnUntraced(function* (dir: string) {
			return yield* fs.readFile(path.join(dir, "codework")).pipe(
				Effect.map((value) => value.trim()),
				Effect.map((value) => (value ? ProjectSchema.ID.make(value) : undefined)),
				Effect.catch(() => Effect.void),
			);
		});

		const remote = Effect.fnUntraced(function* (repo: Git.Repo) {
			const origin = yield* git.remote(repo);
			if (!origin) return undefined;
			const normalized = url(origin);
			if (!normalized) return undefined;
			return {
				id: ProjectSchema.ID.make(Hash.fast(`git:${normalized}`)),
				name: path.basename(normalized),
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
			return root ? ProjectSchema.ID.make(root) : undefined;
		});

		const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
			const repo = yield* git.find(input);
			if (!repo) {
				const local: Resolved = {
					id: ProjectSchema.ID.local,
					directory: input,
					name: path.basename(path.normalize(input)),
				};
				return local;
			}

			const previous = yield* cached(repo.store);
			const origin = yield* remote(repo);
			const id = origin?.id ?? previous ?? (yield* root(repo));
			const resolved: Resolved = {
				id: id ?? ProjectSchema.ID.local,
				...(previous ? { previous } : {}),
				directory: repo.directory,
				vcs: { type: "git", store: repo.store },
				name: origin?.name ?? path.basename(path.normalize(repo.directory)),
			};
			return resolved;
		});

		const migrateProjectId = Effect.fn("Project.migrateProjectID")(function* (
			oldID: ProjectSchema.ID | undefined,
			newID: ProjectSchema.ID,
		) {
			if (!oldID) return; // nothing to migrate from
			if (oldID === ProjectSchema.ID.local) return; // local project copy are ignored
			if (oldID === newID) return; // just the same

			yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const oldProject = yield* findProject(oldID);
						if (Option.isNone(oldProject)) return;

						const newProject = yield* findProject(newID);
						if (Option.isNone(newProject)) {
							const row = yield* ProjectRow.insert.makeEffect({
								id: newID,
								name: oldProject.value.name,
								createdAt: Model.Override(oldProject.value.createdAt),
							});
							yield* insertProject(row);
						}

						// directories cascade-delete with the old project row, so
						// re-home them under the new id (with re-derived row ids)
						// before the delete; directories the new project already
						// registered win the conflict
						const directories = yield* selectAllDirectories(oldID);
						for (const row of directories) {
							const rehomed = yield* ProjectDirectoryRow.insert.makeEffect({
								id: directoryId(newID, row.sandboxInstanceId, row.directory),
								projectId: newID,
								directory: row.directory,
								type: row.type,
								sandboxInstanceId: row.sandboxInstanceId,
								createdAt: Model.Override(row.createdAt),
							});
							yield* insertDirectory(rehomed);
						}

						yield* sql`DELETE FROM project WHERE id = ${oldID}`;
					}),
				)
				.pipe(Effect.orDie);
		});

		const saveDirectory = Effect.fn("Project.saveDirectory")(function* (input: {
			projectId: ProjectSchema.ID;
			directory: string;
		}) {
			if (input.projectId === ProjectSchema.ID.local) return;
			const isGitWorktree = yield* copy.isGitWorktree({
				directory: AbsolutePath.make(input.directory),
			});

			yield* sql
				.withTransaction(
					Effect.gen(function* () {
						// "main" is per environment: each sandbox has its own primary
						// checkout, so a main elsewhere must not demote this one to root.
						const hasMain = yield* sql`
							SELECT directory FROM project_directory
							WHERE project_id = ${input.projectId}
								AND sandbox_instance_id = ${instanceId}
								AND type = 'main'
							LIMIT 1
						`;

						const row = yield* ProjectDirectoryRow.insert.makeEffect({
							id: directoryId(input.projectId, instanceId, input.directory),
							projectId: input.projectId,
							directory: AbsolutePath.make(input.directory),
							type: isGitWorktree ? "gitworktree" : hasMain.length > 0 ? "root" : "main",
							sandboxInstanceId: instanceId,
						});
						yield* insertDirectory(row);
					}),
				)
				.pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() =>
							console.warn("project directory persistence failed", {
								projectId: input.projectId,
								cause,
							}),
						),
					),
				);
		});

		const fromDirectory = Effect.fn("Project.fromDirectory")(function* (directory: string) {
			const data = yield* resolve(AbsolutePath.make(directory));
			const projectId = ProjectSchema.ID.make(data.id);

			// conditionally migrates previous cached projectId to new one
			yield* migrateProjectId(data.previous ? ProjectSchema.ID.make(data.previous) : undefined, projectId);

			const existing = yield* findProject(projectId).pipe(Effect.orDie);
			const name = Option.match(existing, {
				onNone: () => data.name,
				onSome: (row) => row.name,
			});

			// on conflict only the update timestamp moves; the stored name and
			// creation time stay as they are
			const row = yield* ProjectRow.insert.makeEffect({ id: projectId, name }).pipe(Effect.orDie);
			yield* upsertProject(row).pipe(Effect.orDie);

			yield* saveDirectory({ projectId: projectId, directory: data.directory });

			const result: ProjectSchema.Info = {
				id: projectId,
				name,
				vcs: data.vcs ?? undefined,
				directory: data.directory,
			};

			return result;
		});

		return Service.of({ resolve, directories, fromDirectory });
	}),
);

/** Takes an assembled sandbox — local or remote — not a local backend. */
export const layerWith = <E, RIn>(sandbox: Sandbox.Sandbox<E, RIn>) =>
	layer.pipe(
		Layer.provide(Git.layer),
		Layer.provide(ProjectCopy.layer),
		Layer.provide(sandbox),
		Layer.provide(Database.defaultLayer),
	);

export const defaultLayer = (path: string) => layerWith(Sandbox.defaultLayer(path));

export * as Project from "./project";
