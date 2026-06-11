import { Context, Effect, Layer, Schema } from "effect";
import { FileSystem } from "../filesystem/filesystem";
import { Sandbox } from "../sandbox/sandbox";
import { AbsolutePath } from "../schema";

export const IsGitWorktreeInput = Schema.Struct({
	directory: AbsolutePath,
}).annotate({ identifier: "Copy.IsGitWorktreeInput" });
export type IsGitWorktreeInput = typeof IsGitWorktreeInput.Type;

export interface Interface {
	readonly isGitWorktree: (input: IsGitWorktreeInput) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()("@codework/project/copy") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const fs = yield* FileSystem.Service;

		const isGitWorktree = Effect.fn("Copy.isGitWorktree")(function* (input: IsGitWorktreeInput) {
			const found = yield* fs.up({ targets: [".git"], start: input.directory }).pipe(Effect.orDie);

			const dotGit = found[0];
			if (!dotGit) return false; // not inside a git checkout

			// the main checkout keeps `.git` as a directory; a linked worktree
			// has a `.git` file pointing into the shared store's worktrees area
			if (yield* fs.isDir(dotGit)) return false;

			const content = yield* fs.readFileString(dotGit).pipe(Effect.catch(() => Effect.succeed("")));

			const gitdir = content.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
			if (!gitdir) return false;

			return /[\\/]\.git[\\/]worktrees[\\/]/.test(gitdir);
		});

		return Service.of({ isGitWorktree });
	}),
);

export const defaultLayer = (path: string) => layer.pipe(Layer.provide(Sandbox.defaultLayer(path)));

export * as Copy from "./copy";
