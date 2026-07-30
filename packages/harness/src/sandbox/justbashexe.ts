import { RealFSProvider, type VirtualFileSystem } from "@platformatic/vfs";
import { Effect, Layer } from "effect";
import { Bash, type IFileSystem } from "just-bash";
import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { Local } from "./filesystem/local";
import { SandboxIO } from "./io";
import type { LocalPrimitives } from "./sandbox";
import { type ExecResult, fromExec, type ISandboxExe, perMount, Shell, ShellError, type ShellOptions } from "./shell";

// The shared exec contract lives in `shell.ts`; re-export the pieces this
// module used to own so existing `EnvBash.Shell` / `EnvBash.ShellError`
// consumers keep working.
export { Shell, ShellError };
export type { ExecResult, ISandboxExe as Interface };

// just-bash's IFileSystem implemented on top of the sandbox's vfs, so shell
// commands and SandboxFileSystem.Service operate on the very same tree — there is
// exactly one filesystem.
//
interface Metadata {
	readonly mode?: number;
	readonly mtime?: Date;
}

const metadataByVfs = new WeakMap<VirtualFileSystem, Map<string, Metadata>>();

const metadataFor = (vfs: VirtualFileSystem): Map<string, Metadata> => {
	const existing = metadataByVfs.get(vfs);
	if (existing !== undefined) return existing;
	const metadata = new Map<string, Metadata>();
	metadataByVfs.set(vfs, metadata);
	return metadata;
};

// VFS has no chmod/utimes primitives, so bash-visible mode and mtime changes
// are kept in an overlay shared by every bridge over the same VFS. The overlay
// only observes operations made through this bridge: mutating the raw VFS
// directly (for example deleting and recreating a path) can leave a stale
// overlay entry behind. Hard links fail loudly because their shared-inode
// semantics cannot be represented by the VFS API.
export const bridge = (vfs: VirtualFileSystem, cwd: string): IFileSystem => {
	const metadata = metadataFor(vfs);
	const key = (path: string) => vfs.resolvePath(path);
	// Glob expansion enumerates from here. On the host that must be the mount's
	// directory: the VFS is rooted at `/` and never chdirs now, so reading its
	// cwd would enumerate the entire machine for every `*`.
	const walkRoot = () => (vfs.provider instanceof RealFSProvider ? cwd : "/");

	const encodingOf = (options?: { encoding?: string | null } | string) => {
		const encoding = typeof options === "string" ? options : options?.encoding;
		return (encoding ?? "utf8") as BufferEncoding;
	};

	const assertWritable = (method: string, path: string) => {
		if (!vfs.readonly) return;
		const error = new Error(`EROFS: read-only file system, ${method} '${path}'`) as NodeJS.ErrnoException;
		error.code = "EROFS";
		throw error;
	};

	const removeMetadata = (path: string) => {
		const target = key(path);
		for (const item of metadata.keys()) {
			if (item === target || item.startsWith(`${target}/`)) metadata.delete(item);
		}
	};

	const moveMetadata = (src: string, dest: string) => {
		const source = key(src);
		const target = key(dest);
		const moved = [...metadata.entries()].filter(([path]) => path === source || path.startsWith(`${source}/`));
		removeMetadata(dest);
		removeMetadata(src);
		for (const [path, value] of moved) metadata.set(`${target}${path.slice(source.length)}`, value);
	};

	// a write refreshes the VFS's own mtime, so an overlaid mtime from an
	// earlier touch would be stale — drop it and let the provider's show
	const dropOverlaidMtime = async (path: string) => {
		const target = key(await vfs.promises.realpath(path));
		const existing = metadata.get(target);
		if (existing?.mtime === undefined) return;
		if (existing.mode === undefined) metadata.delete(target);
		else metadata.set(target, { mode: existing.mode });
	};

	const rm: IFileSystem["rm"] = async (path, options) => {
		let stats: Awaited<ReturnType<typeof vfs.promises.lstat>>;
		try {
			stats = await vfs.promises.lstat(path);
		} catch (error) {
			// force only pardons missing paths; permission or provider failures
			// must not masquerade as successful cleanup
			if (options?.force && (error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (stats.isDirectory()) {
			if (!options?.recursive) throw new Error(`rm: ${path}: is a directory`);
			for (const name of await vfs.promises.readdir(path)) {
				await rm(posix.join(path, name), options);
			}
			await vfs.promises.rmdir(path);
		} else {
			await vfs.promises.unlink(path);
		}
		removeMetadata(path);
	};

	const cp: IFileSystem["cp"] = async (src, dest, options) => {
		const stats = await vfs.promises.stat(src);
		if (stats.isDirectory()) {
			if (!options?.recursive) throw new Error(`cp: ${src}: is a directory (not copied)`);
			await vfs.promises.mkdir(dest, { recursive: true });
			for (const name of await vfs.promises.readdir(src)) {
				await cp(posix.join(src, name), posix.join(dest, name), options);
			}
		} else {
			await vfs.promises.copyFile(src, dest);
			// just-bash's native filesystem carries mode and mtime over to the
			// copy, but VFS copyFile stamps a fresh mtime — pin the source's
			// bash-visible metadata onto the destination
			const override = metadata.get(key(await vfs.promises.realpath(src)));
			metadata.set(key(await vfs.promises.realpath(dest)), {
				...override,
				mtime: override?.mtime ?? stats.mtime,
			});
		}
	};

	const toStat = (
		path: string,
		stats: {
			isFile(): boolean;
			isDirectory(): boolean;
			isSymbolicLink(): boolean;
			mode: number;
			size: number;
			mtime: Date;
		},
	) => {
		const override = metadata.get(key(path));
		return {
			isFile: stats.isFile(),
			isDirectory: stats.isDirectory(),
			isSymbolicLink: stats.isSymbolicLink(),
			mode: override?.mode === undefined ? stats.mode : (stats.mode & ~0o7777) | override.mode,
			size: stats.size,
			mtime: override?.mtime ?? stats.mtime,
		};
	};

	return {
		readFile: async (path, options) => {
			const content = await vfs.promises.readFile(path, encodingOf(options));
			return content as string;
		},
		readFileBuffer: async (path) => (await vfs.promises.readFile(path)) as Buffer,
		writeFile: async (path, content, options) => {
			await vfs.promises.writeFile(
				path,
				typeof content === "string" ? content : Buffer.from(content),
				encodingOf(options),
			);
			await dropOverlaidMtime(path);
		},
		appendFile: async (path, content, options) => {
			await vfs.promises.appendFile(
				path,
				typeof content === "string" ? content : Buffer.from(content),
				encodingOf(options),
			);
			await dropOverlaidMtime(path);
		},
		// async existence via stat, so the bridge does not depend on a
		// provider's synchronous exists implementation.
		exists: async (path) => {
			try {
				await vfs.promises.stat(path);
				return true;
			} catch {
				return false;
			}
		},
		stat: async (path) => {
			const stats = await vfs.promises.stat(path);
			return toStat(await vfs.promises.realpath(path), stats);
		},
		lstat: async (path) => toStat(path, await vfs.promises.lstat(path)),
		mkdir: async (path, options) => {
			await vfs.promises.mkdir(path, options);
		},
		readdir: (path) => vfs.promises.readdir(path),
		readdirWithFileTypes: async (path) => {
			const entries = await vfs.promises.readdir(path, { withFileTypes: true });
			return entries.map((entry) => ({
				name: entry.name,
				isFile: entry.isFile(),
				isDirectory: entry.isDirectory(),
				isSymbolicLink: entry.isSymbolicLink(),
			}));
		},
		rm,
		cp,
		mv: async (src, dest) => {
			await vfs.promises.rename(src, dest);
			moveMetadata(src, dest);
		},
		resolvePath: (base, path) => posix.resolve(base, path),
		getAllPaths: () => {
			const paths: string[] = [];
			const walk = (dir: string) => {
				let entries: ReturnType<typeof vfs.readdirSync>;
				try {
					entries = vfs.readdirSync(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const entry of entries) {
					const full = posix.join(dir, entry.name);
					paths.push(full);
					if (entry.isDirectory()) walk(full);
				}
			};
			walk(walkRoot());
			return paths;
		},
		chmod: async (path, mode) => {
			assertWritable("chmod", path);
			await vfs.promises.stat(path);
			const target = key(await vfs.promises.realpath(path));
			metadata.set(target, { ...metadata.get(target), mode });
		},
		symlink: (target, linkPath) => vfs.promises.symlink(target, linkPath),
		link: () => Promise.reject(new Error("hard links are not supported by this sandbox")),
		readlink: (path) => vfs.promises.readlink(path),
		realpath: (path) => vfs.promises.realpath(path),
		utimes: async (path, _atime, mtime) => {
			assertWritable("utimes", path);
			await vfs.promises.stat(path);
			const target = key(await vfs.promises.realpath(path));
			metadata.set(target, { ...metadata.get(target), mtime });
		},
	};
};

const fromBash = (bash: Bash): ISandboxExe => {
	const exec = Effect.fn("Shell.exec")(function* (command: string, options?: ShellOptions) {
		return yield* Effect.tryPromise({
			// `tryPromise` aborts this signal when the fiber is interrupted, and
			// just-bash stops at its next statement boundary. Without threading it
			// through, an interrupted command keeps running in-process to
			// completion: the fiber unwinds promptly and the work leaks behind it,
			// still writing to the sandbox filesystem long after its caller is gone.
			try: (signal) => bash.exec(command, { ...options, signal }),
			catch: (cause) => new ShellError({ command, cause }),
		});
	});

	// just-bash parses a command string, so `execArgv` goes through the shared
	// quoting fallback rather than spawning a vector directly.
	return Shell.of(fromExec({ exec }));
};

const make = (vfs: VirtualFileSystem, cwd: string): ISandboxExe => fromBash(new Bash({ fs: bridge(vfs, cwd), cwd }));

// just-bash only needs the async IFileSystem surface. The lone synchronous
// touchpoint, getAllPaths for glob expansion, degrades to an empty list.
const shell = (cwd: string) =>
	Layer.effect(
		Shell,
		Effect.map(Local.Vfs, (vfs) => make(vfs, cwd)),
	);

/**
 * A cached virtual transport whose Bash interpreter is constructed only when a
 * mount binds its cwd. This matches Flue's BashFactory ownership: mounts share
 * the VFS, but shell state (functions, options, command hashes) is mount-local.
 */
export const transport = <E, RIn>(
	inner: Layer.Layer<LocalPrimitives, E, RIn>,
): Layer.Layer<Shell | LocalPrimitives, E, RIn> =>
	Layer.provideMerge(
		Layer.effect(
			Shell,
			Effect.map(Local.Vfs, (vfs) => {
				const root = make(vfs, "/");
				return perMount(root, (cwd) => make(vfs, cwd));
			}),
		),
		inner,
	);

/**
 * Wraps any local VFS-backed sandbox with a just-bash shell that executes
 * against the sandbox's own vfs: pick the filesystem backend (default, inmemory, sqldb) and gain a Shell service on top of it.
 */
// `cwd` is required rather than defaulted. A default of `/` is harmless over a
// VFS and catastrophic over the host: `walkRoot` would enumerate the entire
// machine, synchronously, on the first glob. A caller that has to name the
// directory cannot fall into that by omission.
export const layer = <E, RIn>(
	inner: Layer.Layer<LocalPrimitives, E, RIn>,
	cwd: string,
): Layer.Layer<Shell | LocalPrimitives, E, RIn> =>
	Layer.provideMerge(shell(SandboxIO.resolveMountCwd("/", cwd)), inner);

/**
 * A mount over a bash-wrapped sandbox: `SandboxIO.Current`, the sandbox
 * filesystem, the just-bash Shell, and the backend's own primitives. The
 * Shell-typed counterpart of `Sandbox.services`.
 */
export const services = <E, RIn>(
	inner: Layer.Layer<LocalPrimitives, E, RIn>,
	identity: SandboxIO.Identity,
): Layer.Layer<SandboxIO.Provides | LocalPrimitives, E, RIn> =>
	Layer.provideMerge(SandboxIO.mount(identity), Layer.provideMerge(Local.layer, layer(inner, identity.cwd)));

export * as EnvBash from "./justbashexe";
