import type { VirtualFileSystem, VirtualStats } from "@platformatic/vfs";
import { Context, Effect, Layer } from "effect";
import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { SandboxFileSystem } from "./filesystem";

// The local backend: a `SandboxFileSystem.Service` over a `@platformatic/vfs`
// VirtualFileSystem (in-memory, sqlite, or the real host OS). VFS is a
// local-only concern — remote providers never import this module.

export class Vfs extends Context.Service<Vfs, VirtualFileSystem>()("@codework/sandbox/filesystem/Vfs") {}

const toFileStat = (stats: VirtualStats): SandboxFileSystem.FileStat => ({
	isFile: stats.isFile(),
	isDirectory: stats.isDirectory(),
	isSymbolicLink: stats.isSymbolicLink(),
	size: stats.size,
	mtime: stats.mtime,
});

// The VFS backend authors the Promise-based provider surface; `fromProvider`
// lifts it into the Effect service the harness consumes.
export interface Interface extends SandboxFileSystem.Provider {}

const bytes = (content: string | Uint8Array) =>
	typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);

/**
 * Provider factory method that implements the SandboxFileSytem
 * @param vfs VirtualFileSytem instance
 * @returns SandboxFileSytem provider instance
 */
const make = (vfs: VirtualFileSystem): Interface => {
	// Parents are `fromProvider`'s guarantee, not a backend's — a plain write here.
	const writeFile = async (path: string, content: string | Uint8Array) => {
		await vfs.promises.writeFile(path, bytes(content));
	};

	const readdir = async (path: string) => vfs.promises.readdir(path);

	// Option validation lives in `fromProvider`, ahead of any mutation.
	const rm = async (path: string, options?: SandboxFileSystem.RmOptions) => {
		let stats: VirtualStats;
		try {
			stats = await vfs.promises.lstat(path);
		} catch (cause) {
			if (options?.force && SandboxFileSystem.isNotFoundError(cause)) return;
			throw cause;
		}

		if (stats.isDirectory()) {
			if (!options?.recursive) throw new Error(`rm: ${path}: is a directory`);
			for (const entry of await readdir(path)) {
				await rm(posix.join(path, entry), { recursive: true, force: options.force });
			}
			await vfs.promises.rmdir(path);
			return;
		}

		await vfs.promises.unlink(path);
	};

	return {
		readFile: (path) => vfs.promises.readFile(path, "utf8"),
		readFileBuffer: async (path) => new Uint8Array(await vfs.promises.readFile(path)),
		writeFile,
		stat: async (path) => toFileStat(await vfs.promises.stat(path)),
		// `stat` follows symlinks, so its `isSymbolicLink` describes the target and
		// is always false for a link. Symlink identity is asked for explicitly here
		// instead — the same split the remote backends expose, so a consumer cannot
		// tell local from remote by whether it can see a link at all.
		lstat: async (path) => toFileStat(await vfs.promises.lstat(path)),
		readdir,
		exists: async (path) => {
			try {
				await vfs.promises.stat(path);
				return true;
			} catch (cause) {
				if (SandboxFileSystem.isNotFoundError(cause)) return false;
				throw cause;
			}
		},
		mkdir: async (path, options) => {
			await vfs.promises.mkdir(path, options);
		},
		rm,
	};
};

/** The `SandboxFileSystem.Service` backed by the local {@link Vfs}. */
export const layer = Layer.effect(
	SandboxFileSystem.Service,
	Effect.gen(function* () {
		return SandboxFileSystem.fromProvider(make(yield* Vfs));
	}),
);

export * as Local from "./local";
