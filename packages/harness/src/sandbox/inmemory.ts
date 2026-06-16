import { create, MemoryProvider } from "@platformatic/vfs";
import { Effect, Layer } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import { FileSystem } from "../filesystem/filesystem";
import { Process } from "./process";

export interface Options {
	/** Virtual working directory used to resolve relative filesystem paths. Defaults to "/". */
	readonly cwd?: string;
	/** Initial files to write before optional read-only freeze. */
	readonly seed?: Record<string, string | Uint8Array>;
	/** Copy a host directory into the in-memory filesystem before optional read-only freeze. */
	readonly seedFromDirectory?: {
		readonly path: string;
		readonly target?: string;
	};
	/** Freeze the provider to prevent writes. Defaults to false. */
	readonly readOnly?: boolean;
	/**
	 * Spawn child processes on the host OS even though the filesystem is
	 * virtual. Defaults to false: process execution is refused.
	 */
	readonly hostProcess?: boolean;
}

const copyDirectory = async (
	vfs: ReturnType<typeof create>,
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

// A purely in-memory filesystem with no backing resource to release; every
// layer build gets its own fresh, isolated tree.
export const layer = (options?: Options) =>
	Layer.merge(
		Layer.effect(
			FileSystem.Vfs,
			Effect.promise(async () => {
				const cwd = options?.cwd ?? "/";
				const provider = new MemoryProvider();
				const vfs = create(provider, { moduleHooks: false, virtualCwd: true });

				await vfs.promises.mkdir(cwd, { recursive: true });
				vfs.chdir(cwd);

				if (options?.seedFromDirectory) {
					await copyDirectory(vfs, options.seedFromDirectory.path, options.seedFromDirectory.target ?? cwd);
				}

				for (const [filePath, data] of Object.entries(options?.seed ?? {})) {
					await vfs.promises.mkdir(path.posix.dirname(filePath), { recursive: true });
					await vfs.promises.writeFile(filePath, typeof data === "string" ? data : Buffer.from(data));
				}

				if (options?.readOnly) provider.setReadOnly();
				return vfs;
			}),
		),
		options?.hostProcess ? Process.host : Process.unsupported,
	);

export * as EnvInMemory from "./inmemory";
