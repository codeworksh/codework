import { posix } from "../../util/posix.ts";
import { SandboxFileSystem } from "../../sandbox/fs/filesystem.ts";

export type FileStat = SandboxFileSystem.FileStat;

export interface Interface extends SandboxFileSystem.Provider {
	readonly lstat?: (path: string) => Promise<FileStat>;
}

export interface Options {
	readonly cwd?: string;
}

const resolvePath = (path: string, options?: Options) => {
	const normalized = posix.normalize(path);
	if (options?.cwd === undefined || posix.isAbsolute(normalized)) return normalized;
	return posix.normalize(posix.join(options.cwd, normalized));
};

/** Resolve provider paths without adding policy or mutable working-directory state. */
export const make = (provider: Interface, options?: Options): Interface => {
	const resolve = (path: string) => resolvePath(path, options);

	return {
		readFile: (path) => provider.readFile(resolve(path)),
		readFileBuffer: (path) => provider.readFileBuffer(resolve(path)),
		writeFile: (path, content) => provider.writeFile(resolve(path), content),
		stat: (path) => provider.stat(resolve(path)),
		...(provider.lstat === undefined ? {} : { lstat: (path: string) => provider.lstat!(resolve(path)) }),
		readdir: (path) => provider.readdir(resolve(path)),
		exists: (path) => provider.exists(resolve(path)),
		mkdir: (path, mkdirOptions) => provider.mkdir(resolve(path), mkdirOptions),
		rm: (path, rmOptions) => provider.rm(resolve(path), rmOptions),
	};
};

export const withProvider = make;
