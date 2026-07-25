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
import { SandboxEnv } from "../env";
import { SandboxFileSystem } from "../filesystem/filesystem";
import { RemoteFileSystem } from "../filesystem/remote";
import { type ISandboxExe, quote, quoteArgv, resolveCwd, Shell, ShellError } from "../shell";

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
	/** Remote working directory for relative filesystem and shell operations. */
	readonly cwd?: string;
	/** Idle minutes before the sandbox auto-stops. */
	readonly autoStopInterval?: number;
	/** Per-command timeout in seconds. 0 means no timeout. */
	readonly execTimeout?: number;
	/**
	 * Keep the sandbox alive when the layer is torn down instead of deleting it.
	 * Always true for a reused sandbox (`sandboxId`): a box we did not create is
	 * never deleted.
	 */
	readonly persist?: boolean;
}

interface RemoteState {
	readonly daytona: Daytona;
	readonly sandbox: RemoteSandbox;
	readonly created: boolean;
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
			({ daytona, sandbox, created }) =>
				Effect.promise(() => (created && !options.persist ? daytona.delete(sandbox) : Promise.resolve())).pipe(
					Effect.ignore,
				),
		),
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
		Effect.map(Remote, ({ sandbox }) =>
			SandboxFileSystem.fromProvider(RemoteFileSystem.make(providerFrom(sandbox, options), { cwd: options.cwd })),
		),
	);

const shellLayer = (options: Options) =>
	Layer.effect(
		Shell,
		Effect.map(Remote, ({ sandbox }) =>
			Shell.of({ exec: exec(sandbox, options), execArgv: execArgv(sandbox, options) }),
		),
	);

/**
 * A Daytona sandbox provides the runtime filesystem service directly plus
 * the sandbox's native remote shell. It intentionally does not provide VFS:
 * remote filesystems have no synchronous filesystem surface.
 */
// Identity is per remote sandbox, not per provider: two Daytona sandboxes both
// using /workspace must not share persisted directory records.
const envLayer = () =>
	Layer.effect(
		SandboxEnv.EnvId,
		Effect.map(Remote, ({ sandbox }) => SandboxEnv.format({ kind: "daytona", instance: sandbox.id })),
	);

export const layer = (
	options: Options = {},
): Layer.Layer<SandboxFileSystem.Service | Shell | SandboxEnv.EnvId, DaytonaError> =>
	Layer.mergeAll(filesystemLayer(options), shellLayer(options), envLayer()).pipe(Layer.provide(remote(options)));

export const services = layer;

export * as EnvDaytona from "./daytona";
