import { Deferred, Effect } from "effect";
import fs from "node:fs/promises";
import { join } from "node:path";
import type { SandboxFileSystem } from "../../src/sandbox/fs/filesystem.ts";

/**
 * A host-directory provider whose first write blocks until released: a write in
 * flight that an interrupt cannot call back.
 */
export const gatedProvider = (dir: string, started: Deferred.Deferred<void>, release: Deferred.Deferred<void>) => {
	let writes = 0;
	const at = (path: string) => join(dir, path);
	return {
		secondStarted: () => writes > 1,
		provider: {
			readFile: (path) => fs.readFile(at(path), "utf8"),
			readFileBuffer: async (path) => new Uint8Array(await fs.readFile(at(path))),
			readBytes: () => Promise.reject(new Error("unused")),
			writeFile: async (path, content) => {
				writes++;
				if (writes === 1) {
					Deferred.doneUnsafe(started, Effect.void);
					await Effect.runPromise(Deferred.await(release));
				}
				await fs.writeFile(at(path), content);
			},
			stat: async (path) => {
				const stat = await fs.stat(at(path));
				return { isFile: stat.isFile(), isDirectory: stat.isDirectory() };
			},
			readdir: (path) => fs.readdir(at(path)),
			exists: (path) =>
				fs.stat(at(path)).then(
					() => true,
					() => false,
				),
			mkdir: async (path, options) => {
				await fs.mkdir(at(path), options);
			},
			rm: (path, options) => fs.rm(at(path), options),
			realpath: (path) => fs.realpath(at(path)),
			scanLines: () => Promise.reject(new Error("unused")),
		} satisfies SandboxFileSystem.Provider,
	};
};
