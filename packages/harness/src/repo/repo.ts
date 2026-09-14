import { Context, Effect, Layer } from "effect";
import { Git } from "../git/git.ts";
import { SandboxFs } from "../sandbox/fs/util.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { Sandbox } from "../sandbox/sandbox.ts";
import { AbsolutePath } from "../schema.ts";
import { Hash } from "../util/hash.ts";
import { posix as path } from "../util/posix.ts";
import { RepoSchema } from "./schema.ts";

/** Per-clone file under the store that pins the project id (see PROJECT.md §1 "marker"). */
export const MARKER = "codework";

export interface Identity {
	/** `marker ?? remoteHash ?? rootCommit`; undefined when none is available (caller falls back). */
	readonly id: string | undefined;
	readonly name: string;
	/** True when a portable id was computed and written to the marker this call. */
	readonly stamp: boolean;
}

export interface Interface {
	/** Locate the checkout containing `input`, or undefined when there is none git can read. */
	readonly find: (input: AbsolutePath) => Effect.Effect<RepoSchema.Info | undefined>;
	/** PROJECT.md §5.1 PHASE 2. Stamps the marker when a portable id is found for the first time. */
	readonly identity: (repo: RepoSchema.Info) => Effect.Effect<Identity>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/repo/repo/Service") {}

/**
 * Canonical `host/path` for a remote url (D-URL): host and path lowercased,
 * `.git` suffix and surrounding slashes stripped, scp form accepted.
 * `file:` urls and empty input yield undefined.
 */
export function normalize(url: string): string | undefined {
	const value = url.trim();
	if (!value) return undefined;

	try {
		const parsed = new URL(value);
		if (parsed.protocol === "file:") return undefined;
		return parts(parsed.hostname, parsed.pathname);
	} catch {
		const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/);
		if (scp) return parts(scp[2]!, scp[3]!);
		return undefined;
	}
}

function parts(host: string, name: string) {
	const pathname = name
		.replace(/^\/+/, "")
		.replace(/\.git\/?$/, "")
		.replace(/\/+$/, "");
	if (!host || !pathname) return undefined;
	return `${host}/${pathname}`.toLowerCase();
}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const fs = yield* SandboxIO.FileSystem;
		const git = yield* Git.Service;

		const find = Effect.fn("Repo.find")(function* (input: AbsolutePath) {
			const dotgit = (yield* SandboxFs.up(fs, { targets: [".git"], start: input }))[0];
			if (!dotgit) return undefined;

			const cwd = path.dirname(dotgit);
			const directory = yield* git.revParse(cwd, "--show-toplevel");
			const gitDir = yield* git.revParse(cwd, "--git-dir");
			const store = yield* git.revParse(cwd, "--git-common-dir");
			// bare, corrupt, or no git binary (exit 127) → not a repo we can use
			if (directory === undefined || gitDir === undefined || store === undefined) return undefined;

			return {
				directory: AbsolutePath.make(yield* SandboxFs.realpath(fs, directory)),
				gitDir: AbsolutePath.make(yield* SandboxFs.realpath(fs, gitDir)),
				store: AbsolutePath.make(yield* SandboxFs.realpath(fs, store)),
			} satisfies RepoSchema.Info;
		});

		const identity = Effect.fn("Repo.identity")(function* (repo: RepoSchema.Info) {
			const marker = path.join(repo.store, MARKER);
			const pinned = (yield* SandboxFs.readFileSafe(fs, marker))?.trim() || undefined;

			const url = yield* git.remote(repo.directory);
			const normalized = url === undefined ? undefined : normalize(url);
			const remote =
				normalized === undefined
					? undefined
					: { id: Hash.fast(`git:${normalized}`), name: path.basename(normalized) };

			const root = (yield* git.roots(repo.directory))[0];

			const id = pinned ?? remote?.id ?? root;
			const stamp = pinned === undefined && id !== undefined;
			if (stamp) {
				yield* fs
					.writeFile(marker, id)
					.pipe(
						Effect.catch((error) => Effect.logWarning("Repo.identity: failed to write marker", marker, error)),
					);
			}

			return {
				id,
				name: remote?.name ?? path.basename(repo.directory),
				stamp,
			} satisfies Identity;
		});

		return Service.of({ find, identity });
	}),
);

export const layerWith = <E, RIn>(sandbox: Sandbox.Sandbox<E, RIn>) =>
	layer.pipe(Layer.provide(Git.layer), Layer.provide(sandbox));

export const defaultLayer = (rootPath: string) => layerWith(Sandbox.defaultLayer(rootPath));

export * as Repo from "./repo.ts";
