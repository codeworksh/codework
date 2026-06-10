import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Database } from "../src/db/db";
import { ProjectDirectoryTable, ProjectTable } from "../src/db/schema.sql";
import { FileSystem } from "../src/filesystem/filesystem";
import { Git } from "../src/git/git";
import { Copy } from "../src/project/copy";
import { defaultLayer, ID, Service, layer, type ProjectDirectory } from "../src/project/project";
import { AbsolutePath } from "../src/schema";
import { Hash } from "../src/util/hash";
import { tmpdir } from "./fixtures/tempdir";
import { testEffect } from "./utils/effect";

// Keep the real Database/Global wiring (exercised through Project.defaultLayer)
// off the user's disk: any layer built from path() lands in an in-memory db.
process.env.CODEWORK_DB ??= ":memory:";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

const directory = AbsolutePath.make("/app/codeworksh/codework");
const store = AbsolutePath.make(path.join(directory, ".git"));
const repo = { directory, store } satisfies Git.Repo;

// A real migrated in-memory database, so the tests exercise the actual SQL
// issued by the service (upserts, deletes, txns).
const databaseLayer = () => Database.layerFromPath(":memory:", { migrate: Database.migrateDefault });

interface ProjectOptions {
	// Contents of the `codework` marker file read from the repo store. When
	// undefined the filesystem reports the file as missing.
	cached?: string;
	// Paths reported as missing on disk by the filesystem stub.
	missing?: string[];
	// What the Copy service reports for isGitWorktree.
	worktree?: boolean;
}

const projectLayer = (git: Partial<Git.Interface>, options: ProjectOptions = {}) => {
	const readFileString =
		options.cached === undefined
			? () =>
					Effect.fail(
						new FileSystem.FileSystemError({
							method: "readFileString",
							cause: "not found",
						}),
					)
			: () => Effect.succeed(options.cached!);

	const exists = (target: string) => Effect.succeed(!(options.missing ?? []).includes(target));

	return layer.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				databaseLayer(),
				Layer.succeed(
					FileSystem.Service,
					FileSystem.Service.of({
						readFileString,
						exists,
					} as unknown as FileSystem.Interface),
				),
				Layer.succeed(Git.Service, Git.Service.of(git as Git.Interface)),
				Layer.succeed(
					Copy.Service,
					Copy.Service.of({
						isGitWorktree: () => Effect.succeed(options.worktree ?? false),
					}),
				),
			),
		),
	);
};

// Seed the project tables directly; `directories`/`fromDirectory` assertions
// then go through the service like production code would.
const seedDirectories = (rows: Array<{ directory: string; type: ProjectDirectory["type"] }>) =>
	Effect.gen(function* () {
		const { db } = yield* Database.Service;
		yield* db.insert(ProjectTable).values({ id: "project-1", name: "codework" }).run();
		for (const [index, row] of rows.entries()) {
			yield* db
				.insert(ProjectDirectoryTable)
				.values({
					id: `directory-${index + 1}`,
					projectId: "project-1",
					directory: row.directory,
					type: row.type,
					sandboxEnvID: "sandbox-1",
				})
				.run();
		}
	});

// A repo whose origin/roots/cache can be tweaked per test. Defaults model the
// common "no remote, no cache, no root commits" shape so each test only states
// the branch it cares about.
const gitRepo = (overrides: Partial<Git.Interface> = {}): Partial<Git.Interface> => ({
	find: () => Effect.succeed(repo),
	remote: () => Effect.succeed(undefined),
	roots: () => Effect.succeed([]),
	...overrides,
});

describe("Project", () => {
	describe("resolve", () => {
		const { effect: localIt } = testEffect(
			projectLayer({
				find: () => Effect.succeed(undefined),
			}),
		);

		localIt("uses the directory name outside a Git repository", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const result = yield* project.resolve(directory);

				expect(result).toEqual({
					id: ID.local,
					directory,
					name: "codework",
				});
			}),
		);

		for (const remote of ["https://github.com/codeworksh/codework.git", "git@github.com:codeworksh/codework.git"]) {
			const { effect: gitIt } = testEffect(
				projectLayer(gitRepo({ remote: () => Effect.succeed(remote), roots: () => Effect.succeed(["root"]) })),
			);

			gitIt(`derives the id and name from the remote ${remote}`, () =>
				Effect.gen(function* () {
					const project = yield* Service;
					const result = yield* project.resolve(directory);

					expect(result).toEqual({
						id: ID.make(Hash.fast("git:github.com/codeworksh/codework")),
						directory,
						vcs: { type: "git", store },
						name: "codework",
					});
				}),
			);
		}

		// The remote wins over the root commit even when both are present.
		const { effect: remoteOverRootIt } = testEffect(
			projectLayer(
				gitRepo({
					remote: () => Effect.succeed("https://github.com/codeworksh/codework.git"),
					roots: () => Effect.succeed(["00ffee"]),
				}),
			),
		);

		remoteOverRootIt("prefers the remote id over the root commit", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const result = yield* project.resolve(directory);

				expect(result.id).toEqual(ID.make(Hash.fast("git:github.com/codeworksh/codework")));
				expect(result).not.toHaveProperty("previous");
			}),
		);

		// URL normalization: host casing, trailing slash, ".git" suffix and
		// nested subgroups all collapse to a stable id, and the name is the last
		// path segment.
		for (const { remote, normalized, name } of [
			{
				remote: "https://GitHub.com/CodeworkSH/Codework/",
				normalized: "github.com/CodeworkSH/Codework",
				name: "Codework",
			},
			{
				remote: "git@gitlab.com:group/sub/widget.git",
				normalized: "gitlab.com/group/sub/widget",
				name: "widget",
			},
			{
				remote: "ssh://git@example.com:2222/team/app.git/",
				normalized: "example.com/team/app",
				name: "app",
			},
		]) {
			const { effect: normalizeIt } = testEffect(projectLayer(gitRepo({ remote: () => Effect.succeed(remote) })));

			normalizeIt(`normalizes the remote ${remote}`, () =>
				Effect.gen(function* () {
					const project = yield* Service;
					const result = yield* project.resolve(directory);

					expect(result.id).toEqual(ID.make(Hash.fast(`git:${normalized}`)));
					expect(result.name).toBe(name);
				}),
			);
		}

		// A "file:" remote is local-only and must not produce a stable project id.
		const { effect: fileRemoteIt } = testEffect(
			projectLayer(
				gitRepo({
					remote: () => Effect.succeed("file:///tmp/mirror/codework.git"),
					roots: () => Effect.succeed(["abc123"]),
				}),
			),
		);

		fileRemoteIt("ignores file:// remotes and falls back to the root commit", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const result = yield* project.resolve(directory);

				expect(result).toEqual({
					id: ID.make("abc123"),
					directory,
					vcs: { type: "git", store },
					name: "codework",
				});
			}),
		);

		// The cached `codework` marker is reported as `previous`. With a remote
		// present the remote still owns the id.
		const { effect: cachedWithRemoteIt } = testEffect(
			projectLayer(gitRepo({ remote: () => Effect.succeed("https://github.com/codeworksh/codework.git") }), {
				cached: "old-project-id\n",
			}),
		);

		cachedWithRemoteIt("reports the cached id as previous alongside the remote id", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const result = yield* project.resolve(directory);

				expect(result).toEqual({
					id: ID.make(Hash.fast("git:github.com/codeworksh/codework")),
					previous: ID.make("old-project-id"),
					directory,
					vcs: { type: "git", store },
					name: "codework",
				});
			}),
		);

		// Without a remote the cached id becomes both the current and previous id.
		const { effect: cachedNoRemoteIt } = testEffect(
			projectLayer(gitRepo({ roots: () => Effect.succeed(["root-sha"]) }), { cached: "cached-id" }),
		);

		cachedNoRemoteIt("falls back to the cached id when there is no remote", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const result = yield* project.resolve(directory);

				expect(result).toEqual({
					id: ID.make("cached-id"),
					previous: ID.make("cached-id"),
					directory,
					vcs: { type: "git", store },
					name: "codework",
				});
			}),
		);

		// A blank marker file is treated as absent (no `previous`).
		const { effect: blankCacheIt } = testEffect(
			projectLayer(gitRepo({ roots: () => Effect.succeed(["root-sha"]) }), { cached: "   \n" }),
		);

		blankCacheIt("ignores a blank cached marker and uses the root commit", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const result = yield* project.resolve(directory);

				expect(result).toEqual({
					id: ID.make("root-sha"),
					directory,
					vcs: { type: "git", store },
					name: "codework",
				});
			}),
		);

		// No remote and no cache: the first root commit becomes the id.
		const { effect: rootIt } = testEffect(projectLayer(gitRepo({ roots: () => Effect.succeed(["root-sha"]) })));

		rootIt("derives the id from the root commit when there is no remote or cache", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const result = yield* project.resolve(directory);

				expect(result).toEqual({
					id: ID.make("root-sha"),
					directory,
					vcs: { type: "git", store },
					name: "codework",
				});
			}),
		);

		// Inside a Git repo with nothing to identify it, fall back to the local id.
		const { effect: localInRepoIt } = testEffect(projectLayer(gitRepo()));

		localInRepoIt("falls back to the local id inside a Git repo with no remote, cache, or root", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const result = yield* project.resolve(directory);

				expect(result).toEqual({
					id: ID.local,
					directory,
					vcs: { type: "git", store },
					name: "codework",
				});
			}),
		);
	});

	describe("directories", () => {
		const { effect: directoriesIt } = testEffect(projectLayer({}));

		directoriesIt("returns project directories in lexical order", () =>
			Effect.gen(function* () {
				yield* seedDirectories([
					{ directory: "/workspace/codework-z", type: "root" },
					{ directory: "/workspace/codework", type: "main" },
					{ directory: "/workspace/codework-a", type: "gitworktree" },
				]);

				const project = yield* Service;
				const result = yield* project.directories({ projectID: ID.make("project-1") });

				expect(result).toEqual([
					{ directory: "/workspace/codework", sandboxEnvID: "sandbox-1", type: "main" },
					{ directory: "/workspace/codework-a", sandboxEnvID: "sandbox-1", type: "gitworktree" },
					{ directory: "/workspace/codework-z", sandboxEnvID: "sandbox-1", type: "root" },
				]);
			}),
		);

		directoriesIt("returns an empty list when the project has no directories", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const result = yield* project.directories({ projectID: ID.make("project-1") });

				expect(result).toEqual([]);
			}),
		);

		// Directories missing on disk are dropped from the result and their rows
		// deleted, so the next read no longer pays for the existence check.
		const { effect: staleIt } = testEffect(projectLayer({}, { missing: ["/workspace/gone"] }));

		staleIt("drops and deletes directories that no longer exist on disk", () =>
			Effect.gen(function* () {
				yield* seedDirectories([
					{ directory: "/workspace/codework", type: "main" },
					{ directory: "/workspace/gone", type: "root" },
				]);

				const project = yield* Service;
				const result = yield* project.directories({ projectID: ID.make("project-1") });
				expect(result).toEqual([{ directory: "/workspace/codework", sandboxEnvID: "sandbox-1", type: "main" }]);

				const { db } = yield* Database.Service;
				const remaining = yield* db.select().from(ProjectDirectoryTable).all();
				expect(remaining).toHaveLength(1);
				expect(remaining[0]?.directory).toBe("/workspace/codework");
			}),
		);
	});

	describe("fromDirectory", () => {
		// `find` echoes the opened directory back so one layer can register
		// several distinct directories under the same remote-derived project id.
		const trackingGit = (): Partial<Git.Interface> => ({
			find: (input) => Effect.succeed({ directory: input, store }),
			remote: () => Effect.succeed("https://github.com/codeworksh/codework.git"),
			roots: () => Effect.succeed([]),
		});

		const projectID = ID.make(Hash.fast("git:github.com/codeworksh/codework"));

		const { effect: fromDirectoryIt } = testEffect(projectLayer(trackingGit()));

		fromDirectoryIt("persists the project and registers its directory as main", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const info = yield* project.fromDirectory(directory);

				expect(info).toEqual({
					id: projectID,
					name: "codework",
					vcs: { type: "git", store },
					directory,
				});

				const result = yield* project.directories({ projectID: info.id });
				expect(result).toEqual([{ directory, sandboxEnvID: "@codework/envDefault", type: "main" }]);
			}),
		);

		fromDirectoryIt("registers later directories as root once a main exists", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const second = AbsolutePath.make("/app/codeworksh/codework-b");

				const first = yield* project.fromDirectory(directory);
				const result = yield* project.fromDirectory(second);
				expect(result.id).toEqual(first.id);

				const directories = yield* project.directories({ projectID: result.id });
				expect(directories).toEqual([
					{ directory, sandboxEnvID: "@codework/envDefault", type: "main" },
					{ directory: second, sandboxEnvID: "@codework/envDefault", type: "root" },
				]);
			}),
		);

		fromDirectoryIt("registers the same directory only once", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				yield* project.fromDirectory(directory);
				yield* project.fromDirectory(directory);

				const result = yield* project.directories({ projectID: projectID });
				expect(result).toEqual([{ directory, sandboxEnvID: "@codework/envDefault", type: "main" }]);
			}),
		);

		const { effect: worktreeIt } = testEffect(projectLayer(trackingGit(), { worktree: true }));

		worktreeIt("registers worktree directories with the gitworktree type", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const info = yield* project.fromDirectory(directory);

				const result = yield* project.directories({ projectID: info.id });
				expect(result).toEqual([{ directory, sandboxEnvID: "@codework/envDefault", type: "gitworktree" }]);
			}),
		);

		const { effect: localIt } = testEffect(projectLayer({ find: () => Effect.succeed(undefined) }));

		localIt("skips directory persistence for local projects", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const info = yield* project.fromDirectory(directory);

				expect(info).toEqual({
					id: ID.local,
					name: "codework",
					vcs: undefined,
					directory,
				});

				const result = yield* project.directories({ projectID: ID.local });
				expect(result).toEqual([]);
			}),
		);
	});

	describe("Project.defaultLayer", () => {
		// End-to-end through the real FileSystem + Git + Database layers wired by
		// defaultLayer, without touching the network: a local repo with a fake
		// remote and a cached marker exercises remote derivation and `previous`.
		it("resolves a local Git repository, deriving the id from its remote", async () => {
			await using tmp = await tmpdir();
			const repoDirectory = path.join(tmp.path, "widget");
			await fs.mkdir(repoDirectory);
			await git(repoDirectory, "init", "-q");
			await git(repoDirectory, "config", "user.email", "test@codework.sh");
			await git(repoDirectory, "config", "user.name", "Codework Test");
			await git(repoDirectory, "remote", "add", "origin", "https://github.com/codeworksh/widget.git");
			await fs.writeFile(path.join(repoDirectory, "README.md"), "hello");
			await git(repoDirectory, "add", ".");
			await git(repoDirectory, "commit", "-q", "-m", "init");
			// Cached marker lives in the repo store and is surfaced as `previous`.
			await fs.writeFile(path.join(repoDirectory, ".git", "codework"), "previous-id\n");

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const project = yield* Service;
					return yield* project.resolve(AbsolutePath.make(repoDirectory));
				}).pipe(Effect.provide(defaultLayer("/"))),
			);

			const realDirectory = AbsolutePath.make(await fs.realpath(repoDirectory));
			expect(result).toEqual({
				id: ID.make(Hash.fast("git:github.com/codeworksh/widget")),
				previous: ID.make("previous-id"),
				directory: realDirectory,
				vcs: { type: "git", store: AbsolutePath.make(path.join(realDirectory, ".git")) },
				name: "widget",
			});
		}, 30_000);

		// Outside any repository defaultLayer still resolves to a local project.
		it("resolves a plain directory to the local id", async () => {
			await using tmp = await tmpdir();
			const plain = path.join(tmp.path, "scratch");
			await fs.mkdir(plain);

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const project = yield* Service;
					return yield* project.resolve(AbsolutePath.make(plain));
				}).pipe(Effect.provide(defaultLayer("/"))),
			);

			expect(result).toEqual({
				id: ID.local,
				directory: AbsolutePath.make(plain),
				name: "scratch",
			});
		}, 30_000);

		it("resolves a real GitHub repository cloned into a temporary directory", async () => {
			await using tmp = await tmpdir();
			const cloneDirectory = path.join(tmp.path, "69th");

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const git = yield* Git.Service;
					const clone = yield* git.clone({
						remote: "https://github.com/codeworksh/69th",
						target: cloneDirectory,
						branch: "main",
						depth: 1,
					});
					expect(clone.exitCode, clone.stderr).toBe(0);

					const project = yield* Service;
					return yield* project.resolve(AbsolutePath.make(cloneDirectory));
				}).pipe(Effect.provide(Layer.mergeAll(defaultLayer("/"), Git.defaultLayer("/")))),
			);

			const realDirectory = AbsolutePath.make(await fs.realpath(cloneDirectory));
			expect(result).toEqual({
				id: ID.make(Hash.fast("git:github.com/codeworksh/69th")),
				directory: realDirectory,
				vcs: {
					type: "git",
					store: AbsolutePath.make(path.join(realDirectory, ".git")),
				},
				name: "69th",
			});
		}, 120_000);

		// fromDirectory end-to-end through the full defaultLayer stack: a real
		// repository plus a real linked worktree against the real migrated
		// database wired by Database.defaultLayer (in-memory via CODEWORK_DB).
		it("persists a repository and its linked worktree through fromDirectory", async () => {
			await using tmp = await tmpdir();
			const repoDirectory = path.join(tmp.path, "widget");
			await fs.mkdir(repoDirectory);
			await git(repoDirectory, "init", "-q");
			await git(repoDirectory, "config", "user.email", "test@codework.sh");
			await git(repoDirectory, "config", "user.name", "Codework Test");
			await git(repoDirectory, "remote", "add", "origin", "https://github.com/codeworksh/widget.git");
			await fs.writeFile(path.join(repoDirectory, "README.md"), "hello");
			await git(repoDirectory, "add", ".");
			await git(repoDirectory, "commit", "-q", "-m", "init");
			const worktreeDirectory = path.join(tmp.path, "widget-feature");
			await git(repoDirectory, "worktree", "add", "--detach", worktreeDirectory);

			const { info, worktreeInfo, directories } = await Effect.runPromise(
				Effect.gen(function* () {
					const project = yield* Service;
					const info = yield* project.fromDirectory(AbsolutePath.make(repoDirectory));
					const worktreeInfo = yield* project.fromDirectory(AbsolutePath.make(worktreeDirectory));
					// repeating a directory must not duplicate its row
					yield* project.fromDirectory(AbsolutePath.make(repoDirectory));
					const directories = yield* project.directories({ projectID: info.id });
					return { info, worktreeInfo, directories };
				}).pipe(Effect.provide(defaultLayer("/"))),
			);

			const realRepo = AbsolutePath.make(await fs.realpath(repoDirectory));
			const realWorktree = AbsolutePath.make(await fs.realpath(worktreeDirectory));

			expect(info).toEqual({
				id: ID.make(Hash.fast("git:github.com/codeworksh/widget")),
				name: "widget",
				vcs: { type: "git", store: AbsolutePath.make(path.join(realRepo, ".git")) },
				directory: realRepo,
			});
			expect(worktreeInfo.id).toEqual(info.id);
			expect(worktreeInfo.directory).toBe(realWorktree);
			expect(directories).toEqual([
				{ directory: realRepo, sandboxEnvID: "@codework/envDefault", type: "main" },
				{ directory: realWorktree, sandboxEnvID: "@codework/envDefault", type: "gitworktree" },
			]);
		}, 30_000);
	});
});
