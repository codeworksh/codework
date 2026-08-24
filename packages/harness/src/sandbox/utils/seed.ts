/* oxlint-disable effecttsgo/async-function -- Seeding bridges native files and the Promise-based VFS contract. */
import type { create } from "@platformatic/vfs";
import { Effect, Option } from "effect";
import { Buffer } from "node:buffer";
import { fileSystem } from "../../host.ts";
import { posix } from "../../posix.ts";

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

	for (const name of await Effect.runPromise(fileSystem.readDirectory(sourceDirectory))) {
		const sourcePath = posix.join(sourceDirectory, name);
		const targetPath = posix.join(targetDirectory, name);
		const link = await Effect.runPromise(fileSystem.readLink(sourcePath).pipe(Effect.option));

		if (Option.isSome(link)) {
			await vfs.promises.symlink(link.value, targetPath);
			continue;
		}

		const entry = await Effect.runPromise(fileSystem.stat(sourcePath));

		if (entry.type === "Directory") {
			await copyDirectory(vfs, sourcePath, targetPath);
			continue;
		}

		if (entry.type === "File") {
			await vfs.promises.writeFile(
				targetPath,
				Buffer.from(await Effect.runPromise(fileSystem.readFile(sourcePath))),
			);
		}
	}
};

export const initialize = async (vfs: VirtualFileSystem, options?: SeedOptions): Promise<void> => {
	const cwd = options?.cwd ?? "/";
	if (!posix.isAbsolute(cwd)) {
		throw new TypeError(`Virtual filesystem default cwd must be absolute: ${cwd}`);
	}
	const resolve = (value: string) => (posix.isAbsolute(value) ? posix.normalize(value) : posix.resolve(cwd, value));

	await vfs.promises.mkdir(cwd, { recursive: true });

	if (options?.seedFromDirectory) {
		await copyDirectory(vfs, options.seedFromDirectory.path, resolve(options.seedFromDirectory.target ?? cwd));
	}

	for (const [filePath, data] of Object.entries(options?.seed ?? {})) {
		const target = resolve(filePath);
		await vfs.promises.mkdir(posix.dirname(target), { recursive: true });
		await vfs.promises.writeFile(target, typeof data === "string" ? data : Buffer.from(data));
	}
};

export * as Seed from "./seed.ts";
