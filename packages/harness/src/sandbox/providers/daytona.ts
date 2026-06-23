import {
	type CodeLanguage,
	Daytona,
	type FileInfo,
	type Image,
	type Sandbox as RemoteSandbox,
	type Resources,
} from "@daytona/sdk";
import { Context, Effect, Layer, Schema } from "effect";
import { Buffer } from "node:buffer";
import { SandboxFileSystem } from "../filesystem/filesystem";
import { RemoteFileSystem } from "../filesystem/remote";
import { type ISandboxExe, Shell, ShellError } from "../shell";

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

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

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
		// Daytona's toolbox exposes a single file-details endpoint that reports
		// the entry mode when available. Expose it as remote `lstat` too so
		// symlink-aware callers can ask for that intent explicitly.
		lstat: async (path: string) => statsFrom(await sandbox.fs.getFileDetails(path)),
		readdir: async (path: string) => (await sandbox.fs.listFiles(path)).map((entry) => entry.name),
		exists: async (path: string) => {
			try {
				await sandbox.fs.getFileDetails(path);
				return true;
			} catch {
				return false;
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
const exec =
	(sandbox: RemoteSandbox, options: Options): ISandboxExe["exec"] =>
	(command, opts) =>
		Effect.tryPromise({
			try: () => sandbox.process.executeCommand(command, options.cwd, opts?.env, options.execTimeout),
			catch: (cause) => new ShellError({ command, cause }),
		}).pipe(Effect.map((response) => ({ stdout: response.result ?? "", stderr: "", exitCode: response.exitCode })));

const filesystemLayer = (options: Options) =>
	Layer.effect(
		SandboxFileSystem.Service,
		Effect.map(Remote, ({ sandbox }) => RemoteFileSystem.make(providerFrom(sandbox, options), { cwd: options.cwd })),
	);

const shellLayer = (options: Options) =>
	Layer.effect(
		Shell,
		Effect.map(Remote, ({ sandbox }) => Shell.of({ exec: exec(sandbox, options) })),
	);

/**
 * A Daytona sandbox provides the runtime filesystem service directly plus
 * the sandbox's native remote shell. It intentionally does not provide VFS:
 * remote filesystems have no synchronous filesystem surface.
 */
export const layer = (options: Options = {}): Layer.Layer<SandboxFileSystem.Service | Shell, DaytonaError> =>
	Layer.merge(filesystemLayer(options), shellLayer(options)).pipe(Layer.provide(remote(options)));

export const services = layer;

export * as EnvDaytona from "./daytona";
