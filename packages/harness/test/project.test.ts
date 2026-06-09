import path from "node:path";
import { Effect, Layer } from "effect";
import { describe, expect } from "vite-plus/test";
import { FileSystem } from "../src/filesystem/filesystem";
import { Git } from "../src/git";
import { ID, Service, layer } from "../src/project/project";
import { AbsolutePath } from "../src/schema";
import { Hash } from "../src/util/hash";
import { testEffect } from "./utils/effect";

const directory = AbsolutePath.make("/app/codeworksh/codework");
const store = AbsolutePath.make(path.join(directory, ".git"));
const repo = { directory, store } satisfies Git.Repo;

const projectLayer = (git: Partial<Git.Interface>) =>
	layer.pipe(
		Layer.provide(
			Layer.mergeAll(
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
});
