import { Context, Effect, Layer, Schema } from "effect";
import { Git } from "../git/git.ts";
import { RepoSchema } from "../repo/schema.ts";
import { SandboxFs } from "../sandbox/fs/util.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { Sandbox } from "../sandbox/sandbox.ts";
import { AbsolutePath } from "../schema.ts";

export class WorktreeError extends Schema.TaggedError<WorktreeError>()("Worktree.WorktreeError", {
	operation: Schema.Literals(["add", "remove", "list"]),
	message: Schema.String,
	directory: Schema.optional(AbsolutePath),
	cause: Schema.optional(Schema.Defect()),
}) {}

export interface Entry {
	/** realpath of the checkout */
	readonly location: AbsolutePath;
	/** True for the main checkout (the one owning the store). */
	readonly main: boolean;
}

export interface Input {
	readonly repo: RepoSchema.Info;
	readonly directory: AbsolutePath;
}

export interface Interface {
	/** `git worktree list`, main checkout first. Never prunes (D-PRUNE). */
	readonly list: (repo: RepoSchema.Info) => Effect.Effect<ReadonlyArray<Entry>, WorktreeError>;
	/** Detached worktree at `directory` checked out at the repo's HEAD. */
	readonly add: (input: Input) => Effect.Effect<void, WorktreeError>;
	/** Force-remove the worktree, then prune stale administrative entries. */
	readonly remove: (input: Input) => Effect.Effect<void, WorktreeError>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/worktree/worktree/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const fs = yield* SandboxIO.FileSystem;
		const git = yield* Git.Service;

		const worktree = Effect.fnUntraced(function* (
			operation: WorktreeError["operation"],
			cwd: string,
			args: string[],
			directory?: AbsolutePath,
		) {
			const result = yield* git
				.exec(cwd, ["worktree", ...args])
				.pipe(
					Effect.mapError((cause) => new WorktreeError({ operation, directory, message: cause.message, cause })),
				);
			if (result.exitCode === 0) return result.text;
			return yield* new WorktreeError({
				operation,
				directory,
				message: result.stderr.trim() || result.text.trim() || "Git failed",
			});
		});

		const list = Effect.fn("Worktree.list")(function* (repo: RepoSchema.Info) {
			const text = yield* worktree("list", repo.directory, ["list", "--porcelain"]);
			const locations = text
				.split("\n")
				.filter((line) => line.startsWith("worktree "))
				.map((line) => Git.resolvePath(repo.directory, line.slice("worktree ".length).trim()));
			return yield* Effect.forEach(locations, (location, index) =>
				SandboxFs.realpath(fs, location).pipe(
					Effect.map((real): Entry => ({ location: AbsolutePath.make(real), main: index === 0 })),
				),
			);
		});

		const add = Effect.fn("Worktree.add")(function* (input: Input) {
			yield* worktree("add", input.repo.directory, ["add", "--detach", input.directory, "HEAD"], input.directory);
		});

		const remove = Effect.fn("Worktree.remove")(function* (input: Input) {
			yield* worktree("remove", input.repo.store, ["remove", "--force", input.directory], input.directory);
			yield* git.exec(input.repo.store, ["worktree", "prune"]).pipe(Effect.ignore);
		});

		return Service.of({ list, add, remove });
	}),
);

export const layerWith = <E, RIn>(sandbox: Sandbox.Sandbox<E, RIn>) =>
	layer.pipe(Layer.provide(Git.layer), Layer.provide(sandbox));

export const defaultLayer = (rootPath: string) => layerWith(Sandbox.defaultLayer(rootPath));

export * as Worktree from "./worktree.ts";
