/* oxlint-disable effecttsgo/async-function -- Seeding bridges native files and the Promise-based VFS contract. */
import type { create } from "@platformatic/vfs";
import fs from "node:fs/promises";
import path from "node:path";

export interface SeedOptions {
	/** Virtual working directory used to resolve relative filesystem paths. Defaults to "/". */
	readonly cwd?: string;
	/** Initial files to write before optional read-only freeze. */
	readonly seed?: Record<string, string | Uint8Array>;
	/** Copy a host directory into the sandbox filesystem before optional read-only freeze. */
	readonly seedFromDirectory?: {
		readonly path: string;
		readonly target?: string;
	};
}

type VirtualFileSystem = ReturnType<typeof create>;

const copyDirectory = async (
	vfs: VirtualFileSystem,
	sourceDirectory: string,
	targetDirectory: string,
): Promise<void> => {
	await vfs.promises.mkdir(targetDirectory, { recursive: true });

	for (const entry of await fs.readdir(sourceDirectory, { withFileTypes: true })) {
		const sourcePath = path.join(sourceDirectory, entry.name);
		const targetPath = path.posix.join(targetDirectory, entry.name);

		if (entry.isDirectory()) {
			await copyDirectory(vfs, sourcePath, targetPath);
			continue;
		}

		if (entry.isSymbolicLink()) {
			await vfs.promises.symlink(await fs.readlink(sourcePath), targetPath);
			continue;
		}

		if (entry.isFile()) {
			await vfs.promises.writeFile(targetPath, await fs.readFile(sourcePath));
		}
	}
};

export const initialize = async (vfs: VirtualFileSystem, options?: SeedOptions): Promise<void> => {
	const cwd = options?.cwd ?? "/";
	if (!path.posix.isAbsolute(cwd)) {
		throw new TypeError(`Virtual filesystem default cwd must be absolute: ${cwd}`);
	}
	const resolve = (value: string) =>
		path.posix.isAbsolute(value) ? path.posix.normalize(value) : path.posix.resolve(cwd, value);

	await vfs.promises.mkdir(cwd, { recursive: true });

	if (options?.seedFromDirectory) {
		await copyDirectory(vfs, options.seedFromDirectory.path, resolve(options.seedFromDirectory.target ?? cwd));
	}

	for (const [filePath, data] of Object.entries(options?.seed ?? {})) {
		const target = resolve(filePath);
		await vfs.promises.mkdir(path.posix.dirname(target), { recursive: true });
		await vfs.promises.writeFile(target, typeof data === "string" ? data : Buffer.from(data));
	}
};

export * as Seed from "./seed.ts";
