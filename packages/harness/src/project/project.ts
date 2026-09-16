import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { Database } from "../db/db.ts";
import { ProjectRow } from "../db/schema.sql.ts";
import { Git } from "../git/git.ts";
import { DirectoryNotFoundError, NotDirectoryError, type Error as LocationError } from "../location/error.ts";
import { Repo } from "../repo/repo.ts";
import type { RepoSchema } from "../repo/schema.ts";
import { SandboxFs } from "../sandbox/fs/util.ts";
import { SandboxInstance } from "../sandbox/instance.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { Sandbox } from "../sandbox/sandbox.ts";
import { AbsolutePath } from "../schema.ts";
import { SpaceSchema } from "../space/schema.ts";
import { Space } from "../space/space.ts";
import { Hash } from "../util/hash.ts";
import { posix as path } from "../util/posix.ts";
import { Worktree } from "../worktree/worktree.ts";
import { ProjectSchema } from "./schema.ts";

/** Deterministic, env-local id for a directory without a portable identity. Never written to a marker. */
export const provisional = (env: SandboxInstance.ID, location: string): ProjectSchema.ID =>
	ProjectSchema.ID.make(Hash.fast(JSON.stringify(["dir", SandboxInstance.toColumn(env) ?? "local", location])));

export interface Resolved {
	readonly project: ProjectSchema.Info;
	readonly space: SpaceSchema.Info;
	/** Realpath of `cwd`; equal to or under `space.location`. */
	readonly directory: AbsolutePath;
	/** `space.kind ∈ { primary, plain }` */
	readonly isDefault: boolean;
}

export interface Interface {
	readonly resolveOrCreate: (cwd: AbsolutePath) => Effect.Effect<Resolved, LocationError>;
	readonly get: (id: ProjectSchema.ID) => Effect.Effect<Option.Option<ProjectSchema.Info>>;
	readonly list: () => Effect.Effect<ProjectSchema.Info[]>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/project/project/Service") {}

interface Member {
	readonly location: AbsolutePath;
	readonly main: boolean;
}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const fs = yield* SandboxIO.FileSystem;
		const repos = yield* Repo.Service;
		const worktrees = yield* Worktree.Service;
		const spaces = yield* Space.Service;
		const { id: env } = yield* SandboxIO.Current;
		const envColumn = SandboxInstance.toColumn(env);

		// D-LOCK: one long-running server, so an in-process lock is the global one.
		const lock = yield* Semaphore.make(1);

		const findProject = SqlSchema.findOneOption({
			Request: Schema.String,
			Result: ProjectRow,
			execute: (id) => sql`SELECT * FROM project WHERE id = ${id}`,
		});

		const findAllProjects = SqlSchema.findAll({
			Request: Schema.Void,
			Result: ProjectRow,
			execute: () => sql`SELECT * FROM project ORDER BY name, id`,
		});

		// name and created_at never move on conflict
		const upsertProject = SqlSchema.void({
			Request: ProjectRow.insert,
			execute: (row) => sql`
				INSERT INTO project ${sql.insert(row)}
				ON CONFLICT(id) DO UPDATE SET status = 'active', updated_at = excluded.updated_at
			`,
		});

		const toInfo = (row: ProjectRow, vcs: RepoSchema.Vcs | undefined): ProjectSchema.Info =>
			new ProjectSchema.Info({
				id: ProjectSchema.ID.make(row.id),
				name: row.name,
				status: row.status,
				...(vcs === undefined ? {} : { vcs }),
			});

		// Info carries `vcs` only when resolved from a checkout; a bare lookup has no repo to ask.
		const get = Effect.fn("Project.get")(function* (id: ProjectSchema.ID) {
			return Option.map(yield* findProject(id).pipe(Effect.orDie), (row) => toInfo(row, undefined));
		});

		const list = Effect.fn("Project.list")(function* () {
			return (yield* findAllProjects().pipe(Effect.orDie)).map((row) => toInfo(row, undefined));
		});

		// PHASE 2b: git's worktree list, filtered to what is actually on disk, main first.
		const family = Effect.fnUntraced(function* (repo: RepoSchema.Info) {
			const listed = yield* worktrees.list(repo).pipe(Effect.orElseSucceed((): ReadonlyArray<Member> => []));
			const present = yield* Effect.filter(listed, (member) => SandboxFs.isDirectory(fs, member.location));
			const members: Member[] = present.some((member) => member.location === repo.directory)
				? [...present]
				: [...present, { location: repo.directory, main: repo.gitDir === repo.store }];
			return members.toSorted((a, b) => Number(b.main) - Number(a.main));
		});

		const resolveOrCreate = Effect.fn("Project.resolveOrCreate")(function* (cwd: AbsolutePath) {
			const exists = yield* fs.exists(cwd).pipe(Effect.orDie);
			if (!exists) return yield* new DirectoryNotFoundError({ directory: cwd, sandboxInstanceId: env });
			const stat = yield* fs.stat(cwd).pipe(Effect.orDie);
			if (!stat.isDirectory) return yield* new NotDirectoryError({ directory: cwd, sandboxInstanceId: env });
			const location = AbsolutePath.make(yield* fs.realpath(cwd).pipe(Effect.orDie));

			const repo = yield* repos.find(location);
			const ident = repo === undefined ? undefined : yield* repos.identity(repo);

			const worktree = repo?.directory ?? location;
			const projectId = ident?.id === undefined ? provisional(env, worktree) : ProjectSchema.ID.make(ident.id);
			const name = ident?.name ?? path.basename(worktree);
			const vcs: RepoSchema.Vcs | undefined = repo === undefined ? undefined : { type: "git", store: repo.store };
			const members: ReadonlyArray<Member> =
				repo === undefined ? [{ location: worktree, main: true }] : yield* family(repo);

			const candidates = yield* sql<{ id: string; projectId: string; location: string }>`
				SELECT id, project_id, location FROM space WHERE env IS ${envColumn} AND project_id != ${projectId}
			`.pipe(Effect.orDie);
			const strays = candidates.filter(
				(row) => row.location === worktree || row.location.startsWith(`${worktree}/`),
			);
			// A stray belongs to this checkout only when its nearest `.git` is ours —
			// a nested repository keeps its own project (S12). Plain dirs adopt nothing.
			const dotgit = path.join(worktree, ".git");
			const verified =
				repo === undefined
					? []
					: yield* Effect.filter(strays, (row) =>
							SandboxFs.up(fs, { targets: [".git"], start: row.location }).pipe(
								Effect.map((found) => found[0] === dotgit),
							),
						);

			const primaryRows = yield* sql<{ location: string }>`
				SELECT location FROM space
				WHERE project_id = ${projectId} AND env IS ${envColumn} AND kind = 'primary'
			`.pipe(Effect.orDie);
			let existingPrimary = primaryRows[0]?.location;
			const claim = (location: string) => {
				if (existingPrimary !== undefined && existingPrimary !== location) return false;
				existingPrimary = location;
				return true;
			};

			const worktreeSpaceId = Space.id(env, worktree);

			yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const row = yield* ProjectRow.insert.makeEffect({ id: projectId, name, status: "active" });
						yield* upsertProject(row);

						for (const member of members) {
							const kind: SpaceSchema.Kind =
								repo === undefined
									? "plain"
									: !member.main
										? "linked"
										: claim(member.location)
											? "primary"
											: "copy";
							yield* spaces.rehome({
								id: Space.id(env, member.location),
								projectId,
								location: member.location,
								kind,
								env,
							});
						}

						// Strays at the worktree itself were re-pointed by rehome (same id).
						for (const stray of verified) {
							if (stray.location === worktree) continue;
							yield* spaces.absorb({ strayId: SpaceSchema.ID.make(stray.id), into: worktreeSpaceId });
						}
						// RESTRICT keeps this honest: a project still referenced is left alone.
						for (const strayProject of new Set(verified.map((stray) => stray.projectId))) {
							yield* sql`
								DELETE FROM project WHERE id = ${strayProject}
									AND NOT EXISTS (SELECT 1 FROM space WHERE project_id = ${strayProject})
							`;
						}
					}),
				)
				.pipe(Effect.orDie);

			const project = yield* findProject(projectId).pipe(Effect.orDie);
			const space = yield* spaces.get(worktreeSpaceId);
			if (Option.isNone(project) || Option.isNone(space)) {
				return yield* Effect.die(new Error(`Project.resolveOrCreate: registration vanished for ${worktree}`));
			}

			const resolved: Resolved = {
				project: toInfo(project.value, vcs),
				space: space.value,
				directory: location,
				isDefault: space.value.kind === "primary" || space.value.kind === "plain",
			};
			return resolved;
		}, lock.withPermits(1));

		return Service.of({ resolveOrCreate, get, list });
	}),
);

/** Takes an assembled sandbox — local or remote — not a local backend. */
export const layerWith = <E, RIn>(sandbox: Sandbox.Sandbox<E, RIn>) =>
	layer.pipe(
		Layer.provide(Layer.mergeAll(Repo.layer, Worktree.layer, Space.layer)),
		Layer.provide(Git.layer),
		Layer.provide(sandbox),
		Layer.provide(Database.defaultLayer),
	);

export const defaultLayer = (path: string) => layerWith(Sandbox.defaultLayer(path));

export * as Project from "./project.ts";
