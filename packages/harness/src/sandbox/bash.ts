import type { VirtualFileSystem } from "@platformatic/vfs";
import { Context, Effect, Layer, Schema } from "effect";
import { Bash, type IFileSystem } from "just-bash";
import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { FileSystem } from "../filesystem/filesystem";
import type { Provides } from "./sandbox";

export class ShellError extends Schema.TaggedErrorClass<ShellError>()("ShellError", {
	command: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

export interface ExecResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export interface Interface {
	readonly exec: (
		command: string,
		options?: { env?: Record<string, string> },
	) => Effect.Effect<ExecResult, ShellError>;
}

export class Shell extends Context.Service<Shell, Interface>()("@codework/sandbox/shell") {}

// just-bash's IFileSystem implemented on top of the sandbox's vfs, so shell
// commands and FileSystem.Service operate on the very same tree — there is
// exactly one filesystem.
//
// VFS has no chmod/utimes primitives, so bash-visible mode and mtime changes
// are kept in a shell-local metadata overlay. Hard links fail loudly because
// their shared-inode semantics cannot be represented by the VFS API.
export const bridge = (vfs: VirtualFileSystem): IFileSystem => {
	const metadata = new Map<string, { mode?: number; mtime?: Date }>();
	const key = (path: string) => posix.resolve("/", path);

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

	const rm: IFileSystem["rm"] = async (path, options) => {
		let stats: Awaited<ReturnType<typeof vfs.promises.lstat>>;
		try {
			stats = await vfs.promises.lstat(path);
		} catch (error) {
			if (options?.force) return;
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
		writeFile: (path, content, options) =>
			vfs.promises.writeFile(
				path,
				typeof content === "string" ? content : Buffer.from(content),
				encodingOf(options),
			),
		appendFile: (path, content, options) =>
			vfs.promises.appendFile(
				path,
				typeof content === "string" ? content : Buffer.from(content),
				encodingOf(options),
			),
		exists: (path) => Promise.resolve(vfs.existsSync(path)),
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
			walk("/");
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

const shell = Layer.effect(
	Shell,
	Effect.gen(function* () {
		const vfs = yield* FileSystem.Vfs;
		const bash = new Bash({ fs: bridge(vfs), cwd: "/" });

		const exec = Effect.fn("Shell.exec")(function* (command: string, options?: { env?: Record<string, string> }) {
			return yield* Effect.tryPromise({
				try: () => bash.exec(command, options),
				catch: (cause) => new ShellError({ command, cause }),
			});
		});

		return Shell.of({ exec });
	}),
);

/**
 * Wraps any sandbox with a just-bash shell that executes against the
 * sandbox's own vfs: pick the filesystem backend (default, inmemory, sqldb)
 * and gain a Shell service on top of it.
 */
export const layer = <E, RIn>(inner: Layer.Layer<Provides, E, RIn>): Layer.Layer<Shell | Provides, E, RIn> =>
	Layer.provideMerge(shell, inner);

/**
 * App-facing services for a bash-wrapped sandbox: FileSystem service, Shell,
 * and the sandbox's own capabilities. The Shell-typed counterpart of
 * `Sandbox.services`.
 */
export const services = <E, RIn>(
	inner: Layer.Layer<Provides, E, RIn>,
): Layer.Layer<FileSystem.Service | Shell | Provides, E, RIn> => Layer.provideMerge(FileSystem.layer, layer(inner));

export * as EnvBash from "./bash";
