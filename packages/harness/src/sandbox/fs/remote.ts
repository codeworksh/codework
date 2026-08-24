import { posix } from "../../posix.ts";
import { SandboxFileSystem } from "./filesystem.ts";

// The provider contract and FileStat live in `filesystem.ts` (the single source of truth, VFS-free).
// A remote provider implements this Interface; `make` wraps
// it into the same runtime surface the local vfs backend exposes.
export type FileStat = SandboxFileSystem.FileStat;

// Remote-aware callers can opt into metadata that is not part of the generic
// SandboxFileSystem surface. In particular, `stat` keeps the familiar
// provider-level meaning, while `lstat` explicitly asks for the directory entry
// itself so symlink identity is not inferred from a method with mixed provider
// semantics.
export interface Interface extends SandboxFileSystem.Provider {
	readonly lstat?: (path: string) => Promise<FileStat>;
}

export interface Options {
	/**
	 * Optional remote working directory for relative paths. When omitted, relative
	 * paths are passed through so the remote provider can use its own default cwd.
	 */
	readonly cwd?: string;
}

const resolvePath = (path: string, options?: Options) => {
	const normalized = posix.normalize(path);
	if (options?.cwd === undefined || posix.isAbsolute(normalized)) return normalized;
	return posix.normalize(posix.join(options.cwd, normalized));
};

/**
 * Wrap a remote provider into the runtime filesystem surface: resolve relative
 * paths against `cwd`, and nothing else. Parent creation and `rm` option
 * validation are the runtime's job and live in `SandboxFileSystem.fromProvider`,
 * which every backend passes through — putting them here would cover only the
 * backends that happen to use this wrapper.
 */
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
		// option validation happens in `fromProvider`, before any mutation
		rm: (path, rmOptions) => provider.rm(resolve(path), rmOptions),
	};
};

export const withProvider = make;

export * as RemoteFileSystem from "./remote.ts";
