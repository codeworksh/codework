import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Database } from "../src/db/db";
import { FileSystem } from "../src/filesystem/filesystem";
import { Git } from "../src/git";
import { defaultLayer, ID, Service, layer } from "../src/project/project";
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

const databaseLayer = (rows: Array<{ directory: string }> = []) => {
	const query = {
		from: () => query,
		where: () => query,
		all: () => Effect.succeed(rows),
	};

	return Layer.succeed(
		Database.Service,
		Database.Service.of({
			db: {
				select: () => query,
			},
		} as unknown as Database.Interface),
	);
};

interface ProjectOptions {
	rows?: Array<{ directory: string }>;
	// Contents of the `codework` marker file read from the repo store. When
	// undefined the filesystem reports the file as missing.
	cached?: string;
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

	return layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				databaseLayer(options.rows),
				Layer.succeed(
					FileSystem.Service,
					FileSystem.Service.of({
						readFileString,
					} as unknown as FileSystem.Interface),
				),
				Layer.succeed(Git.Service, Git.Service.of(git as Git.Interface)),
			),
		),
	);
};

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
		const { effect: directoriesIt } = testEffect(
			projectLayer(
				{},
				{
					rows: [
						{ directory: "/workspace/codework-z" },
						{ directory: "/workspace/codework" },
						{ directory: "/workspace/codework-a" },
					],
				},
			),
		);

		directoriesIt("returns project directories in lexical order", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const result = yield* project.directories({ projectID: ID.make("project-1") });

				expect(result).toEqual(["/workspace/codework", "/workspace/codework-a", "/workspace/codework-z"]);
			}),
		);

		const { effect: emptyDirectoriesIt } = testEffect(projectLayer({}, { rows: [] }));

		emptyDirectoriesIt("returns an empty list when the project has no directories", () =>
			Effect.gen(function* () {
				const project = yield* Service;
				const result = yield* project.directories({ projectID: ID.make("project-1") });

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
	});
});
