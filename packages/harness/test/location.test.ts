import { Effect, Layer } from "effect";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { Database } from "../src/db/db";
import { ProjectTable } from "../src/db/schema.sql";
import { FileSystem } from "../src/filesystem/filesystem";
import { Git } from "../src/git/git";
import { Location } from "../src/location/location";
import { Copy } from "../src/project/copy";
import { Project } from "../src/project/project";
import { Sandbox } from "../src/sandbox/sandbox";
import { AbsolutePath } from "../src/schema";
import { Hash } from "../src/util/hash";
import { Workspace } from "../src/workspace/workspace";
import { tmpdir } from "./fixtures/tempdir";
import { testEffect } from "./utils/effect";

// Keep the real Database/Global wiring (exercised through Project.defaultLayer)
// off the user's disk: any layer built from path() lands in an in-memory db.
process.env.CODEWORK_DB ??= ":memory:";

const exec = promisify(execFile);
const gitCli = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

const directory = AbsolutePath.make("/app/codeworksh/codework");
const store = AbsolutePath.make(path.join(directory, ".git"));
const repo = { directory, store } satisfies Git.Repo;

const workspaceID = Workspace.ID.ascending("wrk_location_test");
const projectID = Project.ID.make(Hash.fast("git:github.com/codeworksh/codework"));

const databaseLayer = () => Database.layerFromPath(":memory:", { migrate: Database.migrateDefault });

// Location is an outer layer over Project: these tests stub only Project's
// leaf dependencies (Git/FileSystem/Copy) and run the real Project service
// underneath, so building a Location exercises the same resolution and
// persistence paths production does. Project.Service and the database stay
// merged into the result so tests can assert on what Location created.
const locationLayer = (ref: Location.Ref, git: Partial<Git.Interface>) =>
	Location.layer(ref).pipe(
		Layer.provideMerge(Project.layer),
		Layer.provideMerge(
			Layer.mergeAll(
				databaseLayer(),
				Layer.succeed(
					FileSystem.Service,
					FileSystem.Service.of({
						readFileString: () =>
							Effect.fail(
								new FileSystem.FileSystemError({
									method: "readFileString",
									cause: "not found",
								}),
							),
						exists: () => Effect.succeed(true),
					} as unknown as FileSystem.Interface),
				),
				Layer.succeed(Git.Service, Git.Service.of(git as Git.Interface)),
				Layer.succeed(
					Copy.Service,
					Copy.Service.of({
						isGitWorktree: () => Effect.succeed(false),
					}),
				),
			),
		),
	);

// A repo with a GitHub remote: the common shape where the project id derives
// from the normalized remote URL.
const remoteGit = (overrides: Partial<Git.Interface> = {}): Partial<Git.Interface> => ({
	find: () => Effect.succeed(repo),
	remote: () => Effect.succeed("https://github.com/codeworksh/codework.git"),
	roots: () => Effect.succeed([]),
	...overrides,
});

describe("Location", () => {
	const { effect: locationIt } = testEffect(locationLayer({ directory, workspaceID }, remoteGit()));

	locationIt("resolves the project for the location directory", () =>
		Effect.gen(function* () {
			const location = yield* Location.Service;

			expect(location).toEqual({
				directory,
				workspaceID,
				project: {
					id: projectID,
					name: "codework",
					vcs: { type: "git", store },
					directory,
				},
			});
		}),
	);

	locationIt("creates the project as a side effect of building the location", () =>
		Effect.gen(function* () {
			const location = yield* Location.Service;

			// the project row was persisted ...
			const { db } = yield* Database.Service;
			const rows = yield* db.select().from(ProjectTable).all();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ id: projectID, name: "codework" });

			// ... and the directory registered as main, queryable through Project
			const project = yield* Project.Service;
			const directories = yield* project.directories({ projectID: location.project.id });
			expect(directories).toEqual([{ directory, sandboxEnvID: "@codework/envDefault", type: "main" }]);
		}),
	);

	const { effect: noWorkspaceIt } = testEffect(locationLayer({ directory }, remoteGit()));

	noWorkspaceIt("omits the workspaceID when the ref carries none", () =>
		Effect.gen(function* () {
			const location = yield* Location.Service;

			expect(location.workspaceID).toBeUndefined();
			expect(location.project.id).toEqual(projectID);
		}),
	);

	// The ref may point inside the repository; the location keeps the opened
	// directory while the project reports the repository root.
	const opened = AbsolutePath.make(path.join(directory, "packages", "web"));
	const { effect: nestedIt } = testEffect(locationLayer({ directory: opened, workspaceID }, remoteGit()));

	nestedIt("keeps the opened directory distinct from the resolved project root", () =>
		Effect.gen(function* () {
			const location = yield* Location.Service;

			expect(location.directory).toBe(opened);
			expect(location.project.directory).toBe(directory);

			// the project registers the repository root, not the opened subdirectory
			const project = yield* Project.Service;
			const directories = yield* project.directories({ projectID: location.project.id });
			expect(directories).toEqual([{ directory, sandboxEnvID: "@codework/envDefault", type: "main" }]);
		}),
	);

	const { effect: localIt } = testEffect(
		locationLayer({ directory, workspaceID }, { find: () => Effect.succeed(undefined) }),
	);

	localIt("falls back to the local project outside a Git repository", () =>
		Effect.gen(function* () {
			const location = yield* Location.Service;

			expect(location).toEqual({
				directory,
				workspaceID,
				project: {
					id: Project.ID.local,
					name: "codework",
					vcs: undefined,
					directory,
				},
			});

			// local projects skip directory persistence
			const project = yield* Project.Service;
			const directories = yield* project.directories({ projectID: Project.ID.local });
			expect(directories).toEqual([]);
		}),
	);

	describe("Location.layerWith", () => {
		// layerWith is the seam for swapping the sandbox: a purely in-memory
		// filesystem (no host fs, no process execution) still builds a Location,
		// resolving the directory to a local project since the empty tree holds
		// no repository.
		const ref: Location.Ref = {
			directory: AbsolutePath.make("/workspace/scratch"),
			workspaceID,
		};
		const { effect: inMemoryIt } = testEffect(Location.layerWith(ref, Sandbox.EnvInMemory.layer()));

		inMemoryIt("builds a location over an in-memory sandbox", () =>
			Effect.gen(function* () {
				const location = yield* Location.Service;

				expect(location).toEqual({
					directory: ref.directory,
					workspaceID,
					project: {
						id: Project.ID.local,
						name: "scratch",
						vcs: undefined,
						directory: ref.directory,
					},
				});
			}),
		);
	});

	describe("Location.defaultLayer", () => {
		// End-to-end through the real FileSystem + Git + Database stack: building
		// a Location against a real repository resolves and persists the project,
		// observable through a merged Project.Service sharing the same database.
		it("resolves and persists a real repository through the default stack", async () => {
			await using tmp = await tmpdir();
			const repoDirectory = path.join(tmp.path, "widget");
			await fs.mkdir(repoDirectory);
			await gitCli(repoDirectory, "init", "-q");
			await gitCli(repoDirectory, "config", "user.email", "test@codework.sh");
			await gitCli(repoDirectory, "config", "user.name", "Codework Test");
			await gitCli(repoDirectory, "remote", "add", "origin", "https://github.com/codeworksh/widget.git");
			await fs.writeFile(path.join(repoDirectory, "README.md"), "hello");
			await gitCli(repoDirectory, "add", ".");
			await gitCli(repoDirectory, "commit", "-q", "-m", "init");

			const ref: Location.Ref = {
				directory: AbsolutePath.make(repoDirectory),
				workspaceID,
			};

			const { location, directories } = await Effect.runPromise(
				Effect.gen(function* () {
					const location = yield* Location.Service;
					const project = yield* Project.Service;
					const directories = yield* project.directories({ projectID: location.project.id });
					return { location, directories };
				}).pipe(Effect.provide(Location.layer(ref).pipe(Layer.provideMerge(Project.defaultLayer("/"))))),
			);

			const realDirectory = AbsolutePath.make(await fs.realpath(repoDirectory));
			expect(location).toEqual({
				directory: ref.directory,
				workspaceID,
				project: {
					id: Project.ID.make(Hash.fast("git:github.com/codeworksh/widget")),
					name: "widget",
					vcs: { type: "git", store: AbsolutePath.make(path.join(realDirectory, ".git")) },
					directory: realDirectory,
				},
			});
			expect(directories).toEqual([
				{ directory: realDirectory, sandboxEnvID: "@codework/envDefault", type: "main" },
			]);
		}, 30_000);

		// The convenience wiring itself: defaultLayer needs nothing but the ref
		// and a sandbox root, and still resolves a plain directory to local.
		it("resolves a plain directory to the local project", async () => {
			await using tmp = await tmpdir();
			const plain = path.join(tmp.path, "scratch");
			await fs.mkdir(plain);

			const ref: Location.Ref = { directory: AbsolutePath.make(plain) };

			const location = await Effect.runPromise(
				Effect.gen(function* () {
					return yield* Location.Service;
				}).pipe(Effect.provide(Location.defaultLayer(ref, "/"))),
			);

			expect(location).toEqual({
				directory: ref.directory,
				workspaceID: undefined,
				project: {
					id: Project.ID.local,
					name: "scratch",
					vcs: undefined,
					directory: AbsolutePath.make(plain),
				},
			});
		}, 30_000);
	});
});
