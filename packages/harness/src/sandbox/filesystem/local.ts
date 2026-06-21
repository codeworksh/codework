import type { VirtualFileSystem, VirtualStats } from "@platformatic/vfs";
import { Context, Effect, Layer } from "effect";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
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

// extend Interface; for extending
// allowing for future expansion
export interface Interface extends SandboxFileSystem.Interface {}

const isNotFound = (cause: unknown) => {
	const code = (cause as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
};

const bytes = (content: string | Uint8Array) =>
	typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);

/**
 * Provider factory method that implements the SandboxFileSytem
 * @param vfs VirtualFileSytem instance
 * @returns SandboxFileSytem provider instance
 */
const make = (vfs: VirtualFileSystem): Interface => {
	const writeFile = async (path: string, content: string | Uint8Array) => {
		const data = bytes(content);
		const write = () => vfs.promises.writeFile(path, data);

		try {
			await write();
		} catch {
			await vfs.promises.mkdir(dirname(path), { recursive: true });
			await write();
		}
	};

	const readdir = async (path: string) => vfs.promises.readdir(path);

	const rm = async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
		SandboxFileSystem.assertRmOptions(options);

		let stats: VirtualStats;
		try {
			stats = await vfs.promises.lstat(path);
		} catch (cause) {
			if (options?.force && isNotFound(cause)) return;
			throw cause;
		}

		if (stats.isDirectory()) {
			if (!options?.recursive) throw new Error(`rm: ${path}: is a directory`);
			for (const entry of await readdir(path)) {
				await rm(join(path, entry), { recursive: true, force: options.force });
			}
			await vfs.promises.rmdir(path);
			return;
		}

		await vfs.promises.unlink(path);
	};

	return SandboxFileSystem.Service.of({
		readFile: (path) => vfs.promises.readFile(path, "utf8"),
		readFileBuffer: async (path) => new Uint8Array(await vfs.promises.readFile(path)),
		writeFile,
		stat: async (path) => toFileStat(await vfs.promises.stat(path)),
		readdir,
		exists: async (path) => {
			try {
				await vfs.promises.stat(path);
				return true;
			} catch {
				return false;
			}
		},
		mkdir: async (path, options) => {
			await vfs.promises.mkdir(path, options);
		},
		rm,
	});
};

/** The `SandboxFileSystem.Service` backed by the local {@link Vfs}. */
export const layer = Layer.effect(
	SandboxFileSystem.Service,
	Effect.gen(function* () {
		return make(yield* Vfs);
	}),
);

export * as Virtual from "./local";
