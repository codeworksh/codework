import { Schema } from "effect";
import { AbsolutePath } from "./schema.ts";

// Identified vcs type and its shared storage path.
// Example: `{ type: "git", store: "/app/code/.git" }`
export const Vcs = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("git"),
		store: AbsolutePath,
	}),
]);
export type Vcs = typeof Vcs.Type;

// A discovered git repository. Every path is realpath'd.
export const Info = Schema.Struct({
	/**
	 * The root directory of the working tree that contains the input path
	 * (`rev-parse --show-toplevel`).
	 *
	 * For `/home/me/app/src/file.ts` in a normal clone, this is `/home/me/app`.
	 * For `/home/me/app-feature/src/file.ts` in a linked worktree, this is
	 * `/home/me/app-feature`.
	 */
	directory: AbsolutePath,
	/**
	 * This checkout's own git directory (`rev-parse --git-dir`).
	 *
	 * For a normal clone at `/home/me/app`, this is `/home/me/app/.git`. For a
	 * linked worktree it lives under the store, e.g.
	 * `/home/me/app/.git/worktrees/app-feature`. `gitDir === store` iff this is
	 * the main checkout.
	 */
	gitDir: AbsolutePath,
	/**
	 * The shared Git storage directory used by this repo and any linked
	 * worktrees (`rev-parse --git-common-dir`).
	 *
	 * For a normal clone at `/home/me/app`, this is usually `/home/me/app/.git`.
	 * For a linked worktree at `/home/me/app-feature` whose main checkout is
	 * `/home/me/app`, this is usually `/home/me/app/.git`.
	 */
	store: AbsolutePath,
});
export type Info = typeof Info.Type;

export * as RepoSchema from "./repo.ts";
