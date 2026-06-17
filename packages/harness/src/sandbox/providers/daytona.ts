import {
	type CodeLanguage,
	Daytona,
	type FileInfo,
	type Image,
	type Sandbox as RemoteSandbox,
	type Resources,
} from "@daytona/sdk";
import { create, type VirtualDirent, VirtualProvider, type VirtualStats } from "@platformatic/vfs";
import { Context, Effect, Layer, Schema } from "effect";
import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { FileSystem } from "../../filesystem/filesystem";
import { type ISandboxExe, Shell, ShellError } from "../adapter";
import type { Provides } from "../sandbox";
import { Process } from "../utils/process";

/**
 * Daytona as a pluggable sandbox, the same shape as the other backends: a
 * `FileSystem.Vfs` provider plus a `Shell`. {@link DaytonaProvider} is a
 * `@platformatic/vfs` provider backed by the remote toolbox, so it drops into
 * `FileSystem.layer`, `EnvBash.layer`, `Sandbox.services`, etc. unchanged. The
 * `Shell` is the sandbox's own remote shell (`process.executeCommand`) — the
 * way to run real binaries (git, node, ...). just-bash can also run over the
 * vfs, but only its built-in coreutils, never the sandbox's real toolchain.
 *
 * A remote backend has no synchronous I/O, so the provider's `*Sync` methods
 * throw and paths must be absolute (no `chdir`); the async surface — what
 * `vfs.promises.*` and `FileSystem.Service` use — is fully implemented.
 */

export class DaytonaError extends Schema.TaggedErrorClass<DaytonaError>()("DaytonaError", {
	cause: Schema.optional(Schema.Defect()),
}) {}

export interface Options {
	/** API key. Falls back to the `DAYTONA_API_KEY` env var when omitted. */
	readonly apiKey?: string;
	/** API URL. Falls back to `DAYTONA_API_URL` / the SDK default. */
	readonly apiUrl?: string;
	/** Target region. Falls back to `DAYTONA_TARGET` / the SDK default. */
	readonly target?: string;
	/** Reuse an existing sandbox by id or name instead of creating one. */
	readonly sandboxId?: string;
	/** Snapshot to create the sandbox from. */
	readonly snapshot?: string;
	/** Image (registry reference or declarative `Image`) to create the sandbox from. */
	readonly image?: string | Image;
	/** Runtime used for code execution. Defaults to `"typescript"`. */
	readonly language?: CodeLanguage | string;
	/** Environment variables baked into the sandbox. */
	readonly envVars?: Record<string, string>;
	/** Resource allocation (cpu / memory / disk). */
	readonly resources?: Resources;
	/** OS user to run as inside the sandbox. */
	readonly user?: string;
	/** Idle minutes before the sandbox auto-stops. */
	readonly autoStopInterval?: number;
	/** Per-command timeout in seconds. 0 means no timeout. */
	readonly execTimeout?: number;
	/**
	 * Keep the sandbox alive when the layer is torn down instead of deleting
	 * it. Always true for a reused sandbox (`sandboxId`): a box we did not
	 * create is never deleted.
	 */
	readonly persist?: boolean;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const unsupportedSync = (method: string): never => {
	const error = new Error(
		`ENOSYS: the daytona sandbox provider has no synchronous filesystem operations, ${method}`,
	) as NodeJS.ErrnoException;
	error.code = "ENOSYS";
	throw error;
};

const notFound = (method: string, path: string): NodeJS.ErrnoException => {
	const error = new Error(`ENOENT: no such file or directory, ${method} '${path}'`) as NodeJS.ErrnoException;
	error.code = "ENOENT";
	return error;
};

// Toolbox FileInfo -> the node-fs-style stats VFS consumers expect. The shape
// is structurally a VirtualStats (fields + is*() methods); the cast keeps it
// terse since the class constructor is not part of the package's public types.
const buildStats = (info: FileInfo): VirtualStats => {
	const symlink = info.mode?.startsWith("l") ?? false;
	const mode = Number.parseInt(info.permissions, 8) || (info.isDir ? 0o755 : 0o644);
	const parsed = Date.parse(info.modifiedAt ?? info.modTime);
	const ms = Number.isNaN(parsed) ? Date.now() : parsed;
	const size = info.size ?? 0;
	return {
		dev: 0,
		mode,
		nlink: 1,
		uid: 0,
		gid: 0,
		rdev: 0,
		blksize: 4096,
		ino: 0,
		size,
		blocks: Math.ceil(size / 512),
		atimeMs: ms,
		mtimeMs: ms,
		ctimeMs: ms,
		birthtimeMs: ms,
		atime: new Date(ms),
		mtime: new Date(ms),
		ctime: new Date(ms),
		birthtime: new Date(ms),
		isFile: () => !info.isDir && !symlink,
		isDirectory: () => info.isDir,
		isSymbolicLink: () => symlink,
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isFIFO: () => false,
		isSocket: () => false,
	} as unknown as VirtualStats;
};

const encodingOf = (options?: { encoding?: BufferEncoding | null } | BufferEncoding | null) =>
	typeof options === "string" ? options : (options?.encoding ?? undefined);

/**
 * A `@platformatic/vfs` provider whose tree is a remote Daytona sandbox. The
 * async methods map to the toolbox file API, with shell commands filling the
 * gaps it does not expose (cp, symlinks, realpath). Synchronous methods throw:
 * a remote backend cannot serve synchronous I/O.
 */
class DaytonaProvider extends VirtualProvider {
	private readonly sandbox: RemoteSandbox;

	constructor(sandbox: RemoteSandbox) {
		super();
		this.sandbox = sandbox;
	}

	override get supportsSymlinks() {
		return true;
	}

	// === synchronous surface: unavailable on a remote backend ===
	override statSync(): never {
		return unsupportedSync("statSync");
	}
	override lstatSync(): never {
		return unsupportedSync("lstatSync");
	}
	override existsSync(): never {
		return unsupportedSync("existsSync");
	}
	override readdirSync(): never {
		return unsupportedSync("readdirSync");
	}
	override readFileSync(): never {
		return unsupportedSync("readFileSync");
	}
	override realpathSync(): never {
		return unsupportedSync("realpathSync");
	}
	override openSync(): never {
		return unsupportedSync("openSync");
	}

	// === asynchronous surface ===

	// shell fallback for operations the toolbox file API does not expose; a
	// non-zero exit surfaces as a rejection so callers see real failures
	async run(command: string): Promise<string> {
		const result = await this.sandbox.process.executeCommand(command);
		if (result.exitCode !== 0) throw new Error(result.result || `command failed (${result.exitCode}): ${command}`);
		return result.result ?? "";
	}

	override async stat(path: string): Promise<VirtualStats> {
		try {
			return buildStats(await this.sandbox.fs.getFileDetails(path));
		} catch {
			throw notFound("stat", path);
		}
	}

	// the toolbox does not distinguish lstat from stat; both resolve the path
	override async lstat(path: string): Promise<VirtualStats> {
		return this.stat(path);
	}

	override async exists(path: string): Promise<boolean> {
		try {
			await this.sandbox.fs.getFileDetails(path);
			return true;
		} catch {
			return false;
		}
	}

	override async readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] | VirtualDirent[]> {
		const entries = await this.sandbox.fs.listFiles(path);
		if (!options?.withFileTypes) return entries.map((entry) => entry.name);
		return entries.map((info) => {
			const symlink = info.mode?.startsWith("l") ?? false;
			return {
				name: info.name,
				parentPath: path,
				path: posix.join(path, info.name),
				isFile: () => !info.isDir && !symlink,
				isDirectory: () => info.isDir,
				isSymbolicLink: () => symlink,
				isBlockDevice: () => false,
				isCharacterDevice: () => false,
				isFIFO: () => false,
				isSocket: () => false,
			};
		}) as unknown as VirtualDirent[];
	}

	// `mkdir -p` is idempotent, matching recursive semantics; a bare `mkdir`
	// rejects on an existing path or missing parent, matching non-recursive
	override async mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined> {
		await this.run(`mkdir ${options?.recursive ? "-p " : ""}${quote(path)}`);
		return undefined;
	}

	override async rmdir(path: string): Promise<void> {
		await this.run(`rmdir ${quote(path)}`);
	}

	override async unlink(path: string): Promise<void> {
		await this.sandbox.fs.deleteFile(path);
	}

	override async rename(oldPath: string, newPath: string): Promise<void> {
		await this.sandbox.fs.moveFiles(oldPath, newPath);
	}

	override async readFile(
		path: string,
		options?: { encoding?: BufferEncoding | null } | BufferEncoding | null,
	): Promise<Buffer | string> {
		const buffer = await this.sandbox.fs.downloadFile(path);
		const encoding = encodingOf(options);
		return encoding ? buffer.toString(encoding) : buffer;
	}

	override async writeFile(
		path: string,
		data: string | Buffer,
		options?: { encoding?: BufferEncoding } | BufferEncoding,
	): Promise<void> {
		const buffer = typeof data === "string" ? Buffer.from(data, encodingOf(options) ?? "utf8") : Buffer.from(data);
		await this.sandbox.fs.uploadFile(buffer, path);
	}

	override async appendFile(
		path: string,
		data: string | Buffer,
		options?: { encoding?: BufferEncoding } | BufferEncoding,
	): Promise<void> {
		const addition = typeof data === "string" ? Buffer.from(data, encodingOf(options) ?? "utf8") : Buffer.from(data);
		let existing: Buffer;
		try {
			existing = await this.sandbox.fs.downloadFile(path);
		} catch {
			existing = Buffer.alloc(0);
		}
		await this.sandbox.fs.uploadFile(Buffer.concat([existing, addition]), path);
	}

	override async copyFile(src: string, dest: string): Promise<void> {
		await this.run(`cp ${quote(src)} ${quote(dest)}`);
	}

	override async realpath(path: string): Promise<string> {
		return (await this.run(`realpath ${quote(path)}`)).replace(/\n$/, "");
	}

	override async readlink(path: string): Promise<string> {
		return (await this.run(`readlink ${quote(path)}`)).replace(/\n$/, "");
	}

	override async symlink(target: string, path: string): Promise<void> {
		await this.run(`ln -s ${quote(target)} ${quote(path)}`);
	}

	override async access(path: string): Promise<void> {
		await this.stat(path);
	}
}

interface RemoteState {
	readonly daytona: Daytona;
	readonly sandbox: RemoteSandbox;
	readonly created: boolean;
}

// The live remote sandbox, created (or looked up) once and shared by the vfs
// and shell layers so a single layer build talks to one box.
class Remote extends Context.Service<Remote, RemoteState>()("@codework/sandbox/daytona/remote") {}

const createSandbox = (daytona: Daytona, options: Options) => {
	const base = {
		language: options.language ?? "typescript",
		envVars: options.envVars,
		user: options.user,
		autoStopInterval: options.autoStopInterval,
	};
	return options.image !== undefined
		? daytona.create({ ...base, image: options.image, resources: options.resources })
		: daytona.create({ ...base, snapshot: options.snapshot });
};

const remote = (options: Options) =>
	Layer.effect(
		Remote,
		Effect.acquireRelease(
			Effect.tryPromise({
				try: async (): Promise<RemoteState> => {
					const daytona = new Daytona({ apiKey: options.apiKey, apiUrl: options.apiUrl, target: options.target });
					const sandbox = options.sandboxId
						? await daytona.get(options.sandboxId)
						: await createSandbox(daytona, options);
					return { daytona, sandbox, created: options.sandboxId === undefined };
				},
				catch: (cause) => new DaytonaError({ cause }),
			}),
			// only delete sandboxes we created, and only when not asked to keep
			// them; teardown failures must not mask the program's own outcome
			({ daytona, sandbox, created }) =>
				Effect.promise(() => (created && !options.persist ? daytona.delete(sandbox) : Promise.resolve())).pipe(
					Effect.ignore,
				),
		),
	);

// Daytona's execute API folds stderr into `result` and reports a single exit
// code, so the shell surfaces the combined output as stdout and leaves stderr
// empty rather than inventing a split.
const exec =
	(sandbox: RemoteSandbox, options: Options): ISandboxExe["exec"] =>
	(command, opts) =>
		Effect.tryPromise({
			try: () => sandbox.process.executeCommand(command, undefined, opts?.env, options.execTimeout),
			catch: (cause) => new ShellError({ command, cause }),
		}).pipe(Effect.map((response) => ({ stdout: response.result ?? "", stderr: "", exitCode: response.exitCode })));

// a vfs with no virtual cwd: a remote backend cannot chdir (statSync), so paths
// are absolute and relative ones resolve against the VFS root
const vfsLayer = Layer.effect(
	FileSystem.Vfs,
	Effect.map(Remote, ({ sandbox }) => create(new DaytonaProvider(sandbox), { moduleHooks: false })),
);

const shellLayer = (options: Options) =>
	Layer.effect(
		Shell,
		Effect.map(Remote, ({ sandbox }) => Shell.of({ exec: exec(sandbox, options) })),
	);

/**
 * Just the remote sandbox's filesystem as a `FileSystem.Vfs` (with no host
 * process execution), so it composes like any other sandbox — drive it with
 * `EnvBash.layer` for in-process just-bash, or use `layer` below for the
 * sandbox's own remote shell.
 */
export const vfs = (options: Options = {}): Layer.Layer<Provides, DaytonaError> =>
	Layer.merge(vfsLayer, Process.unsupported).pipe(Layer.provide(remote(options)));

/**
 * A Daytona sandbox: its remote filesystem (`FileSystem.Vfs`) plus its own
 * remote `Shell`. The sandbox is created on layer build and deleted on
 * teardown unless reused (`sandboxId`) or `persist` is set.
 */
export const layer = (options: Options = {}): Layer.Layer<FileSystem.Vfs | Shell, DaytonaError> =>
	Layer.merge(vfsLayer, shellLayer(options)).pipe(Layer.provide(remote(options)));

/**
 * App-facing services for a Daytona sandbox: FileSystem service, the remote
 * Shell, and the Vfs. The remote counterpart of `EnvBash.services`.
 */
export const services = (
	options: Options = {},
): Layer.Layer<FileSystem.Service | Shell | FileSystem.Vfs, DaytonaError> =>
	Layer.provideMerge(FileSystem.layer, layer(options));

export * as EnvDaytona from "./daytona";
