import { posix } from "node:path";
import { SandboxFileSystem } from "./filesystem";

// The provider contract and FileStat live in `filesystem.ts` (the single source of truth, VFS-free).
// A remote provider implements this Interface; `make` wraps
// it into the same runtime surface the local vfs backend exposes.
export type FileStat = SandboxFileSystem.FileStat;

// Remote-aware callers can opt into metadata that is not part of the generic
// SandboxFileSystem surface. In particular, `stat` keeps the familiar
// provider-level meaning, while `lstat` explicitly asks for the directory entry
// itself so symlink identity is not inferred from a method with mixed provider
// semantics.
export interface Interface extends SandboxFileSystem.Interface {
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
 * paths against `cwd`, and guarantee `writeFile` creates missing parents (the
 * runtime's job, not the provider's). `exists` and `rm` delegate to the
 * provider — only the parent-creation and option validation are added here.
 */
export const make = (provider: Interface, options?: Options): Interface => {
	const resolve = (path: string) => resolvePath(path, options);

	return {
		readFile: (path) => provider.readFile(resolve(path)),
		readFileBuffer: (path) => provider.readFileBuffer(resolve(path)),
		writeFile: async (path, content) => {
			const target = resolve(path);
			try {
				await provider.writeFile(target, content);
			} catch {
				await provider.mkdir(posix.dirname(target), { recursive: true });
				await provider.writeFile(target, content);
			}
		},
		stat: (path) => provider.stat(resolve(path)),
		...(provider.lstat === undefined ? {} : { lstat: (path: string) => provider.lstat!(resolve(path)) }),
		readdir: (path) => provider.readdir(resolve(path)),
		exists: (path) => provider.exists(resolve(path)),
		mkdir: (path, mkdirOptions) => provider.mkdir(resolve(path), mkdirOptions),
		// validate before delegating so every provider rejects unsupported flags
		// identically, before any mutation
		rm: (path, rmOptions) => {
			SandboxFileSystem.assertRmOptions(rmOptions);
			return provider.rm(resolve(path), rmOptions);
		},
	};
};

export const withProvider = make;

export * as RemoteFileSystem from "./remote";
