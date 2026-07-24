import { Context, Effect, Layer, Schema } from "effect";
import { SandboxFileSystem } from "../sandbox/filesystem/filesystem";
import { SandboxFs } from "../sandbox/filesystem/util";
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
		const fs = yield* SandboxFileSystem.Service;

		const isGitWorktree = Effect.fn("Copy.isGitWorktree")(function* (input: IsGitWorktreeInput) {
			const found = yield* SandboxFs.up(fs, { targets: [".git"], start: input.directory });

			const dotGit = found[0];
			if (!dotGit) return false; // not inside a git checkout

			// the main checkout keeps `.git` as a directory; a linked worktree
			// has a `.git` file pointing into the shared store's worktrees area
			if (yield* SandboxFs.isDirectory(fs, dotGit)) return false;

			const content = (yield* SandboxFs.readFileSafe(fs, dotGit)) ?? "";

			const gitdir = content.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
			if (!gitdir) return false;

			return /[\\/]\.git[\\/]worktrees[\\/]/.test(gitdir);
		});

		return Service.of({ isGitWorktree });
	}),
);

/** Inspect the working tree inside the given sandbox — local, remote, or virtual. */
export const layerWith = <E, RIn>(sandbox: Sandbox.Sandbox<E, RIn>) => layer.pipe(Layer.provide(sandbox));

export const defaultLayer = (path: string) => layerWith(Sandbox.defaultLayer(path));

export * as ProjectCopy from "./copy";
