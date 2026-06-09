import fs from "node:fs/promises";
import path from "node:path";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Database } from "../src/db/db";
import { FileSystem } from "../src/filesystem/filesystem";
import { Git } from "../src/git";
import { ID, Service, layer } from "../src/project/project";
import { AbsolutePath } from "../src/schema";
import { Hash } from "../src/util/hash";
import { tmpdir } from "./fixtures/tempdir";
import { testEffect } from "./utils/effect";

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

const projectLayer = (git: Partial<Git.Interface>, rows: Array<{ directory: string }> = []) => {
	return layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				databaseLayer(rows),
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
					} as unknown as FileSystem.Interface),
				),
				Layer.succeed(Git.Service, Git.Service.of(git as Git.Interface)),
			),
		),
	);
};

describe("Project", () => {
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
			projectLayer({
				find: () => Effect.succeed(repo),
				remote: () => Effect.succeed(remote),
				roots: () => Effect.succeed(["root"]),
			}),
		);

		gitIt(`derives the name from ${remote}`, () =>
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

	it("resolves a real GitHub repository cloned into a temporary directory", async () => {
		await using tmp = await tmpdir();
		const cloneDirectory = path.join(tmp.path, "69th");
		const liveLayer = Layer.provideMerge(
			layer,
			Layer.mergeAll(databaseLayer(), FileSystem.defaultLayer("/"), Git.defaultLayer("/")),
		);

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
			}).pipe(Effect.provide(liveLayer)),
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

	const directoriesFixture = projectLayer({}, [
		{ directory: "/workspace/codework-z" },
		{ directory: "/workspace/codework" },
		{ directory: "/workspace/codework-a" },
	]);
	const { effect: directoriesIt } = testEffect(directoriesFixture);

	directoriesIt("returns project directories in lexical order", () =>
		Effect.gen(function* () {
			const project = yield* Service;
			const result = yield* project.directories({ projectID: ID.make("project-1") });

			expect(result).toEqual(["/workspace/codework", "/workspace/codework-a", "/workspace/codework-z"]);
		}),
	);
});
