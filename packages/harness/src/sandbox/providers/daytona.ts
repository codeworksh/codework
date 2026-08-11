import {
	type CodeLanguage,
	Daytona,
	DaytonaNotFoundError,
	type FileInfo,
	type Image,
	type Sandbox as RemoteSandbox,
	type Resources,
} from "@daytona/sdk";
import { Context, Effect, Layer, Schema } from "effect";
import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { sanitizeError } from "../errors.ts";
import { SandboxFileSystem } from "../fs/filesystem.ts";
import { RemoteFileSystem } from "../fs/remote.ts";
import { SandboxInstance } from "../instance.ts";
import { SandboxIO } from "../io.ts";
import { SandboxResource } from "../resource.ts";
import { type ISandboxExe, quote, quoteArgv, resolveCwd, Shell, ShellError } from "../shell/shell.ts";

/** Fallback when Daytona cannot report a snapshot/image-specific work directory. */
export const DEFAULT_CWD = "/home/daytona";

/**
 * The mount cwd for a Daytona namespace.
 *
 * An absolute override replaces the namespace default outright, so the
 * `getWorkDir()` round-trip is skipped: it would discover a value we then throw
 * away. Otherwise the sandbox's own work directory is the default, and
 * {@link DEFAULT_CWD} covers a snapshot or image that reports none.
 *
 * Taken as a thunk rather than read off the sandbox so all three branches are
 * testable without provisioning one — this decides where every Daytona mount
 * roots, and §8.1 makes a wrong answer here resolve silently rather than fail.
 */
export const mountCwd = async (
	cwd: string | undefined,
	getWorkDir: () => Promise<string | undefined>,
): Promise<string> => {
	const defaultCwd = posix.isAbsolute(cwd ?? "") ? DEFAULT_CWD : ((await getWorkDir()) ?? DEFAULT_CWD);
	return SandboxIO.resolveMountCwd(defaultCwd, cwd);
};

export class DaytonaError extends Schema.TaggedErrorClass<DaytonaError>()("DaytonaError", {
	sanitized: SandboxInstance.PersistedError,
}) {}

export interface Options {
	/** API key. Falls back to the `DAYTONA_API_KEY` env var when omitted. */
	readonly apiKey?: string | undefined;
	/** API URL. Falls back to `DAYTONA_API_URL` / the SDK default. */
	readonly apiUrl?: string | undefined;
	/** Target region. Falls back to `DAYTONA_TARGET` / the SDK default. */
	readonly target?: string | undefined;
	/** Reuse an existing sandbox by id or name instead of creating one. */
	readonly sandboxId?: string | undefined;
	/** Durable instance identity for this namespace. Supplied by the Controller. */
	readonly instanceId?: SandboxInstance.ID | undefined;
	/** Snapshot to create the sandbox from. */
	readonly snapshot?: string | undefined;
	/** Image (registry reference or declarative `Image`) to create the sandbox from. */
	readonly image?: string | Image | undefined;
	/** Runtime used for code execution. Defaults to `"typescript"`. */
	readonly language?: CodeLanguage | string | undefined;
	/** Environment variables baked into the sandbox. */
	readonly envVars?: Record<string, string> | undefined;
	/** Resource allocation (cpu / memory / disk). */
	readonly resources?: Resources | undefined;
	/** OS user to run as inside the sandbox. */
	readonly user?: string | undefined;
	/**
	 * Mount working directory. Relative values resolve against `getWorkDir()`;
	 * omitted values use it, with `/home/daytona` as the provider fallback.
	 */
	readonly cwd?: string | undefined;
	/** Idle minutes before the sandbox auto-stops. */
	readonly autoStopInterval?: number | undefined;
	/** Per-command timeout in seconds. 0 means no timeout. */
	readonly execTimeout?: number | undefined;
}

interface RemoteState {
	readonly sandbox: RemoteSandbox;
	readonly cwd: string;
}

class Remote extends Context.Service<Remote, RemoteState>()("@codework/sandbox/daytona/remote") {}

const assertCommandSucceeded = (command: string, result: { exitCode: number; result?: string }) => {
	if (result.exitCode !== 0) throw new Error(result.result || `command failed (${result.exitCode}): ${command}`);
};

const dateFrom = (value: string | undefined) => {
	if (value === undefined) return undefined;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? undefined : new Date(ms);
};

export const createSandbox = (daytona: Daytona, options: Options) => {
	const base = {
		language: options.language ?? "typescript",
		...(options.envVars === undefined ? {} : { envVars: options.envVars }),
		...(options.user === undefined ? {} : { user: options.user }),
		...(options.autoStopInterval === undefined ? {} : { autoStopInterval: options.autoStopInterval }),
		autoDeleteInterval: -1,
	};
	return options.image !== undefined
		? daytona.create({
				...base,
				image: options.image,
				...(options.resources === undefined ? {} : { resources: options.resources }),
			})
		: daytona.create({ ...base, ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }) });
};

const remote = (options: Options) =>
	Layer.effect(
		Remote,
		Effect.tryPromise({
			try: async (): Promise<RemoteState> => {
				const daytona = new Daytona({
					...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
					...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
					...(options.target === undefined ? {} : { target: options.target }),
				});
				const sandbox = options.sandboxId
					? await daytona.get(options.sandboxId)
					: await createSandbox(daytona, options);
				return {
					sandbox,
					cwd: await mountCwd(options.cwd, () => sandbox.getWorkDir()),
				};
			},
			catch: (cause) => new DaytonaError({ sanitized: sanitizeError(cause) }),
		}),
	);

export const statsFrom = (info: FileInfo): RemoteFileSystem.FileStat => {
	const symlink = info.mode === undefined ? undefined : info.mode.startsWith("l");
	const mtime = dateFrom(info.modifiedAt ?? info.modTime);

	// omit size/mtime/isSymbolicLink the toolbox did not report — never fabricate
	return {
		isFile: !info.isDir && symlink !== true,
		isDirectory: info.isDir,
		...(symlink === undefined ? {} : { isSymbolicLink: symlink }),
		...(info.size === undefined ? {} : { size: info.size }),
		...(mtime === undefined ? {} : { mtime }),
	};
};

type RemoteFilesystemProvider = Pick<
	RemoteFileSystem.Interface,
	"readFile" | "readFileBuffer" | "writeFile" | "stat" | "lstat" | "readdir" | "exists" | "mkdir" | "rm"
>;

const providerFrom = (sandbox: RemoteSandbox, options: Options) => {
	const filesystem: RemoteFilesystemProvider = {
		readFile: async (path: string) => (await sandbox.fs.downloadFile(path)).toString("utf8"),
		readFileBuffer: async (path: string) => new Uint8Array(await sandbox.fs.downloadFile(path)),
		writeFile: (path: string, content: string | Uint8Array) =>
			sandbox.fs.uploadFile(typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content), path),
		stat: async (path: string) => statsFrom(await sandbox.fs.getFileDetails(path)),
		// The toolbox file-details endpoint follows symlinks. Detect the entry
		// with the sandbox shell first so lstat never reports target metadata as
		// if it described the link itself.
		lstat: async (path: string) => {
			const command = `test -L ${quote(path)}`;
			const result = await sandbox.process.executeCommand(command, options.cwd, undefined, options.execTimeout);
			if (result.exitCode === 0) {
				return { isFile: false, isDirectory: false, isSymbolicLink: true };
			}
			if (result.exitCode === 1) return statsFrom(await sandbox.fs.getFileDetails(path));
			assertCommandSucceeded(command, result);
			throw new Error(`unreachable lstat result for ${path}`);
		},
		readdir: async (path: string) => (await sandbox.fs.listFiles(path)).map((entry) => entry.name),
		// Only a genuine 404 means "absent". Auth, rate-limit, and transport
		// failures propagate: a caller that deletes records on absence must not
		// be told a path is gone because the API was briefly unreachable.
		exists: async (path: string) => {
			try {
				await sandbox.fs.getFileDetails(path);
				return true;
			} catch (cause) {
				if (cause instanceof DaytonaNotFoundError) return false;
				throw cause;
			}
		},
		mkdir: async (path: string, mkdirOptions?: { recursive?: boolean }) => {
			if (!mkdirOptions?.recursive) {
				await sandbox.fs.createFolder(path, "755");
				return;
			}

			const command = `mkdir -p ${quote(path)}`;
			const result = await sandbox.process.executeCommand(command, options.cwd, undefined, options.execTimeout);
			assertCommandSucceeded(command, result);
		},
		rm: async (path: string, rmOptions?: { recursive?: boolean; force?: boolean }) => {
			if (rmOptions?.force && !(await filesystem.exists(path))) return;
			try {
				await sandbox.fs.deleteFile(path, rmOptions?.recursive);
			} catch (cause) {
				if (rmOptions?.force && !(await filesystem.exists(path))) return;
				throw cause;
			}
		},
	};

	return filesystem;
};

// Daytona's execute API folds stderr into `result` and reports a single exit
// code, so the shell surfaces the combined output as stdout and leaves stderr
// empty rather than inventing a split.
const runCommand = (
	sandbox: RemoteSandbox,
	options: Options,
	command: string,
	opts?: { env?: Record<string, string>; cwd?: string },
) =>
	Effect.tryPromise({
		try: () =>
			sandbox.process.executeCommand(command, resolveCwd(options.cwd, opts?.cwd), opts?.env, options.execTimeout),
		catch: (cause) => new ShellError({ command, cause }),
	}).pipe(Effect.map((response) => ({ stdout: response.result ?? "", stderr: "", exitCode: response.exitCode })));

const exec =
	(sandbox: RemoteSandbox, options: Options): ISandboxExe["exec"] =>
	(command, opts) =>
		runCommand(sandbox, options, command, opts);

// `executeCommand` takes a single string, so the vector is quoted here rather
// than spawned; the per-call cwd rides the toolbox's own cwd argument instead
// of a `cd` prefix.
const execArgv =
	(sandbox: RemoteSandbox, options: Options): ISandboxExe["execArgv"] =>
	(argv, opts) =>
		runCommand(sandbox, options, quoteArgv(argv), opts);

const filesystemLayer = (options: Options) =>
	Layer.effect(
		SandboxFileSystem.Service,
		Effect.map(Remote, ({ sandbox, cwd }) => {
			const mounted = { ...options, cwd };
			return SandboxFileSystem.fromProvider(RemoteFileSystem.make(providerFrom(sandbox, mounted), { cwd }));
		}),
	);

const shellLayer = (options: Options) =>
	Layer.effect(
		Shell,
		Effect.map(Remote, ({ sandbox, cwd }) => {
			const mounted = { ...options, cwd };
			return Shell.of({ exec: exec(sandbox, mounted), execArgv: execArgv(sandbox, mounted) });
		}),
	);

/**
 * Cwd-neutral IO attachment for a lifecycle driver.
 *
 * Mount wrappers supply an absolute cwd to every public operation. Internal
 * filesystem helper commands already receive absolute paths, so the transport
 * itself keeps no mutable working-directory state and owns no resource
 * finalizer.
 */
export const transport = (
	sandbox: RemoteSandbox,
	options: Pick<Options, "execTimeout"> = {},
): Layer.Layer<SandboxFileSystem.Service | Shell> =>
	Layer.merge(
		Layer.succeed(
			SandboxFileSystem.Service,
			SandboxFileSystem.fromProvider(RemoteFileSystem.make(providerFrom(sandbox, options))),
		),
		Layer.succeed(
			Shell,
			Shell.of({
				exec: exec(sandbox, options),
				execArgv: execArgv(sandbox, options),
			}),
		),
	);

// Daytona's locator is the sandbox id. See `SandboxResource` for why this is a
// shared tag rather than a Daytona-specific one.
const resourceLayer = Layer.effect(
	SandboxResource.Service,
	Effect.map(Remote, ({ sandbox }) => ({ providerResourceId: sandbox.id })),
);

// Identity is per remote sandbox, not per provider: two sandboxes both rooted at
// the same directory must not share persisted directory records.
//
// The id is minted here only when the caller names none. A durable id is the
// control plane's to mint and record — deriving one from the provider's own
// locator is what §6.1 forbids — so a caller that needs the namespace to survive
// a restart passes `instanceId` rather than relying on this.
const identityLayer = (options: Options) =>
	Layer.effect(
		SandboxIO.Current,
		Effect.map(Remote, ({ cwd }) =>
			SandboxIO.remote({
				driver: "daytona",
				id: options.instanceId ?? SandboxInstance.ID.create(),
				defaultCwd: cwd,
			}),
		),
	);

/**
 * A Daytona sandbox provides the runtime filesystem service directly plus
 * the sandbox's native remote shell. It intentionally does not provide VFS:
 * remote filesystems have no synchronous filesystem surface.
 */
export const layer = (options: Options = {}): Layer.Layer<SandboxIO.Provides | SandboxResource.Service, DaytonaError> =>
	Layer.mergeAll(filesystemLayer(options), shellLayer(options), identityLayer(options), resourceLayer).pipe(
		Layer.provide(remote(options)),
	);

export const services = layer;

export * as EnvDaytona from "./daytona.ts";
