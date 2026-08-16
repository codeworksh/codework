/* oxlint-disable effecttsgo/async-function -- Vercel's sandbox SDK boundary is Promise-based. */
import { type Command, Sandbox as RemoteSandbox } from "@vercel/sandbox";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Buffer } from "node:buffer";
import type { Stats } from "node:fs";
import { sanitizeError } from "../errors.ts";
import { SandboxFileSystem } from "../fs/filesystem.ts";
import { RemoteFileSystem } from "../fs/remote.ts";
import { SandboxInstance } from "../instance.ts";
import { SandboxIO } from "../io.ts";
import { SandboxResource } from "../resource.ts";
import {
	type ExecChunk,
	type ExecResult,
	type ISandboxExe,
	quoteArgv,
	resolveCwd,
	Shell,
	ShellError,
} from "../shell/shell.ts";

const utf8 = new TextEncoder();

/** Vercel's namespace-intrinsic working directory. */
export const DEFAULT_CWD = "/vercel/sandbox";

export class VercelError extends Schema.TaggedError<VercelError>()("VercelError", {
	sanitized: SandboxInstance.PersistedError,
}) {}

/**
 * Vercel API credentials. Either all three are provided together or none are:
 * when omitted, the SDK resolves them from the `VERCEL_OIDC_TOKEN` env var
 * (the token's payload carries the project and team ids).
 */
export interface Credentials {
	readonly token: string;
	readonly teamId: string;
	readonly projectId: string;
}

export interface Options {
	/** Auth token (OIDC or access token). Falls back to `VERCEL_OIDC_TOKEN`. */
	readonly token?: string | undefined;
	/** Team id. Derived from the OIDC token when omitted. */
	readonly teamId?: string | undefined;
	/** Project id. Derived from the OIDC token when omitted. */
	readonly projectId?: string | undefined;
	/** Reuse an existing sandbox by name instead of creating one. */
	readonly sandboxName?: string | undefined;
	/** Explicit name for a newly created sandbox. */
	readonly name?: string | undefined;
	/** Provider-side diagnostic labels (maximum five). */
	readonly tags?: Record<string, string> | undefined;
	/** Durable instance identity for this namespace. Supplied by the Controller. */
	readonly instanceId?: SandboxInstance.ID | undefined;
	/** Snapshot id to create the sandbox from. */
	readonly snapshot?: string | undefined;
	/** Source to seed the sandbox filesystem from (git or tarball). */
	readonly source?:
		| {
				readonly type: "git";
				readonly url: string;
				readonly revision?: string | undefined;
				readonly depth?: number | undefined;
		  }
		| { readonly type: "tarball"; readonly url: string };
	/** Runtime used by the sandbox. Defaults to the SDK default (`node24`). */
	readonly runtime?: string | undefined;
	/** Ports to expose from the sandbox (max 4). */
	readonly ports?: number[] | undefined;
	/** Environment variables baked into the sandbox. */
	readonly envVars?: Record<string, string> | undefined;
	/** vCPU allocation (memory scales at 2048 MB per vCPU). */
	readonly vcpus?: number | undefined;
	/**
	 * Mount working directory. Relative values resolve against `/vercel/sandbox`;
	 * omitted values use that namespace default.
	 */
	readonly cwd?: string | undefined;
	/** Milliseconds before the sandbox auto-terminates. */
	readonly timeout?: number | undefined;
	/** Per-command timeout in milliseconds. Omit for no timeout. */
	readonly execTimeout?: number | undefined;
}

interface RemoteState {
	readonly sandbox: RemoteSandbox;
}

class Remote extends Context.Service<Remote, RemoteState>()("@codeworksh/harness/sandbox/providers/vercel/Remote") {}

// Vercel requires all three credential fields together or none — partial
// credentials are rejected by the SDK — so only forward them when complete.
export const credentialsFrom = (options: Options): Credentials | undefined =>
	options.token !== undefined && options.teamId !== undefined && options.projectId !== undefined
		? { token: options.token, teamId: options.teamId, projectId: options.projectId }
		: undefined;

export const createSandbox = (options: Options, creds: Credentials | undefined = credentialsFrom(options)) => {
	const withCreds = <T extends object>(params: T) => (creds ? { ...params, ...creds } : params);
	const source =
		options.source?.type === "git"
			? {
					type: "git" as const,
					url: options.source.url,
					...(options.source.revision === undefined ? {} : { revision: options.source.revision }),
					...(options.source.depth === undefined ? {} : { depth: options.source.depth }),
				}
			: options.source;
	const base = {
		...(options.name === undefined ? {} : { name: options.name }),
		...(options.tags === undefined ? {} : { tags: options.tags }),
		...(options.envVars === undefined ? {} : { env: options.envVars }),
		...(options.ports === undefined ? {} : { ports: options.ports }),
		...(options.timeout === undefined ? {} : { timeout: options.timeout }),
		...(options.vcpus === undefined ? {} : { resources: { vcpus: options.vcpus } }),
	};
	return options.snapshot !== undefined
		? RemoteSandbox.create(
				withCreds({ ...base, source: { type: "snapshot" as const, snapshotId: options.snapshot } }),
			)
		: RemoteSandbox.create(
				withCreds({
					...base,
					...(options.runtime === undefined ? {} : { runtime: options.runtime }),
					...(source === undefined ? {} : { source }),
				}),
			);
};

const remote = (options: Options) =>
	Layer.effect(
		Remote,
		Effect.tryPromise({
			try: async (): Promise<RemoteState> => {
				const creds = credentialsFrom(options);
				const sandbox = options.sandboxName
					? await RemoteSandbox.get(
							creds ? { ...creds, name: options.sandboxName } : { name: options.sandboxName },
						)
					: await createSandbox(options, creds);
				return { sandbox };
			},
			catch: (cause) => new VercelError({ sanitized: sanitizeError(cause) }),
		}),
	);

export const statsFrom = (stats: Stats): RemoteFileSystem.FileStat => {
	const mtime = stats.mtime;

	// omit size/mtime the stat could not report — never fabricate
	return {
		isFile: stats.isFile(),
		isDirectory: stats.isDirectory(),
		isSymbolicLink: stats.isSymbolicLink(),
		...(Number.isFinite(stats.size) ? { size: stats.size } : {}),
		...(mtime instanceof Date && !Number.isNaN(mtime.getTime()) ? { mtime } : {}),
	};
};

type RemoteFilesystemProvider = Pick<
	RemoteFileSystem.Interface,
	"readFile" | "readFileBuffer" | "writeFile" | "stat" | "lstat" | "readdir" | "exists" | "mkdir" | "rm"
>;

// The Vercel `fs` surface is `node:fs/promises`-compatible, so the provider
// maps almost directly. The `RemoteFileSystem.make` wrapper resolves relative
// paths against `cwd` and guarantees parent creation on `writeFile`.
const providerFrom = (sandbox: RemoteSandbox): RemoteFilesystemProvider => {
	const filesystem: RemoteFilesystemProvider = {
		readFile: (path: string) => sandbox.fs.readFile(path, "utf8"),
		readFileBuffer: async (path: string) => new Uint8Array(await sandbox.fs.readFile(path)),
		writeFile: (path: string, content: string | Uint8Array) =>
			sandbox.fs.writeFile(path, typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content)),
		stat: async (path: string) => statsFrom(await sandbox.fs.stat(path)),
		// Keep symlink identity explicit: Vercel's `stat` follows symlinks
		// (`stat -L`), so remote-aware callers must ask for `lstat` when they
		// need the entry itself instead of the target's metadata.
		lstat: async (path: string) => statsFrom(await sandbox.fs.lstat(path)),
		// `withFileTypes` lists via `find`, which includes dotfiles (`.git` …);
		// the bare `readdir` shells out to `ls -1` and would drop them.
		readdir: async (path: string) => (await sandbox.fs.readdir(path, { withFileTypes: true })).map((e) => e.name),
		exists: async (path: string) => {
			try {
				await sandbox.fs.stat(path);
				return true;
			} catch (cause) {
				if (SandboxFileSystem.isNotFoundError(cause)) return false;
				throw cause;
			}
		},
		mkdir: async (path: string, mkdirOptions?: { recursive?: boolean }) => {
			await sandbox.fs.mkdir(
				path,
				mkdirOptions?.recursive === undefined ? {} : { recursive: mkdirOptions.recursive },
			);
		},
		// `rm -f` is native, so force/recursive delegate straight through; the
		// wrapper has already rejected any unsupported option before we get here.
		rm: (path: string, rmOptions?: { recursive?: boolean; force?: boolean }) =>
			sandbox.fs.rm(path, {
				...(rmOptions?.recursive === undefined ? {} : { recursive: rmOptions.recursive }),
				...(rmOptions?.force === undefined ? {} : { force: rmOptions.force }),
			}),
	};

	return filesystem;
};

// Arbitrary command strings run through `sh -c` to match the single-string
// contract the rest of the harness expects. Commands run **detached** so the
// returned `Command` exposes `kill`/`logs`/`wait`: a `cwd`/`env` is threaded in,
// and the per-command `execTimeout` is a server-side SIGKILL deadline.
const spawn = (
	sandbox: RemoteSandbox,
	options: Options,
	command: string,
	env?: Record<string, string>,
	cwd?: string,
): Promise<Command> => spawnArgv(sandbox, options, ["sh", "-c", command], env, cwd);

// Vercel spawns a program with a real argument vector, so `execArgv` needs no
// quoting at all — the args never pass through a shell.
const spawnArgv = (
	sandbox: RemoteSandbox,
	options: Options,
	argv: ReadonlyArray<string>,
	env?: Record<string, string>,
	cwd?: string,
): Promise<Command> => {
	const resolvedCwd = resolveCwd(options.cwd, cwd);
	return sandbox.runCommand({
		cmd: argv[0]!,
		args: argv.slice(1),
		...(resolvedCwd === undefined ? {} : { cwd: resolvedCwd }),
		...(env === undefined ? {} : { env }),
		detached: true,
		...(options.execTimeout === undefined ? {} : { timeoutMs: options.execTimeout }),
	});
};

// Acquire a detached command and register its kill as a scope finalizer, so an
// interrupt / timeout from the consumer actually terminates the remote process
// (best-effort SIGKILL) instead of leaving it running server-side.
// `command` labels failures only; the spawn itself is supplied by the caller so
// string and argv execution share one kill finalizer.
const acquireWith = (command: string, run: () => Promise<Command>) =>
	Effect.acquireRelease(Effect.tryPromise({ try: run, catch: (cause) => new ShellError({ command, cause }) }), (cmd) =>
		Effect.promise(() => cmd.kill("SIGKILL").catch(() => {})),
	);

// Vercel reports stdout and stderr separately with a distinct exit code, so the
// shell surfaces both streams faithfully.
const collect = (command: string) => (cmd: Command) =>
	Effect.tryPromise({
		try: async (): Promise<ExecResult> => {
			const result = await cmd.wait();
			const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
			return { stdout, stderr, exitCode: result.exitCode };
		},
		catch: (cause) => new ShellError({ command, cause }),
	});

const acquireCommand = (
	sandbox: RemoteSandbox,
	options: Options,
	command: string,
	env?: Record<string, string>,
	cwd?: string,
) => acquireWith(command, () => spawn(sandbox, options, command, env, cwd));

const exec =
	(sandbox: RemoteSandbox, options: Options): ISandboxExe["exec"] =>
	(command, opts) =>
		acquireCommand(sandbox, options, command, opts?.env, opts?.cwd).pipe(
			Effect.flatMap(collect(command)),
			Effect.scoped,
		);

const execArgv =
	(sandbox: RemoteSandbox, options: Options): ISandboxExe["execArgv"] =>
	(argv, opts) => {
		// quoted for the error label only — the spawn passes argv through untouched
		const command = quoteArgv(argv);
		return acquireWith(command, () => spawnArgv(sandbox, options, argv, opts?.env, opts?.cwd)).pipe(
			Effect.flatMap(collect(command)),
			Effect.scoped,
		);
	};

// Streaming output via `Command.logs` (an async generator of stdout/stderr
// entries), followed by the exit code from `wait`. The kill finalizer fires when
// the consuming scope closes (interrupt / timeout).
const stream =
	(sandbox: RemoteSandbox, options: Options): NonNullable<ISandboxExe["stream"]> =>
	(command, opts) =>
		Stream.unwrap(
			acquireCommand(sandbox, options, command, opts?.env, opts?.cwd).pipe(
				Effect.map((cmd) => {
					const logs = Stream.fromAsyncIterable(cmd.logs(), (cause) => new ShellError({ command, cause })).pipe(
						Stream.map((log): ExecChunk => ({ _tag: log.stream, bytes: utf8.encode(log.data) })),
					);
					const exit = Stream.fromEffect(
						Effect.tryPromise({ try: () => cmd.wait(), catch: (cause) => new ShellError({ command, cause }) }),
					).pipe(Stream.map((finished): ExecChunk => ({ _tag: "exit", exitCode: finished.exitCode })));
					return Stream.concat(logs, exit);
				}),
			),
		);

const filesystemLayer = (options: Options) =>
	Layer.effect(
		SandboxFileSystem.Service,
		Effect.map(Remote, ({ sandbox }) =>
			SandboxFileSystem.fromProvider(
				RemoteFileSystem.make(providerFrom(sandbox), options.cwd === undefined ? undefined : { cwd: options.cwd }),
			),
		),
	);

const shellLayer = (options: Options) =>
	Layer.effect(
		Shell,
		Effect.map(Remote, ({ sandbox }) =>
			Shell.of({
				exec: exec(sandbox, options),
				execArgv: execArgv(sandbox, options),
				stream: stream(sandbox, options),
			}),
		),
	);

/**
 * Cwd-neutral IO attachment for a lifecycle driver.
 *
 * The controller binds a cwd per mount, so neither filesystem nor shell stores
 * one here. The returned layer owns no provider resource and has no deletion
 * finalizer.
 */
export const transport = (
	sandbox: RemoteSandbox,
	options: Pick<Options, "execTimeout"> = {},
): Layer.Layer<SandboxFileSystem.Service | Shell> =>
	Layer.merge(
		Layer.succeed(
			SandboxFileSystem.Service,
			SandboxFileSystem.fromProvider(RemoteFileSystem.make(providerFrom(sandbox))),
		),
		Layer.succeed(
			Shell,
			Shell.of({
				exec: exec(sandbox, options),
				execArgv: execArgv(sandbox, options),
				stream: stream(sandbox, options),
			}),
		),
	);

// Vercel's locator is the sandbox name. See `SandboxResource` for why this is a
// shared tag rather than a Vercel-specific one.
const resourceLayer = Layer.effect(
	SandboxResource.Service,
	Effect.map(Remote, ({ sandbox }) => ({ providerResourceId: sandbox.name })),
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
		Effect.map(Remote, () =>
			SandboxIO.remote({
				driver: "vercel",
				id: options.instanceId ?? SandboxInstance.ID.create(),
				defaultCwd: DEFAULT_CWD,
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			}),
		),
	);

/**
 * A Vercel sandbox provides the runtime filesystem service directly plus the
 * sandbox's native remote shell. It intentionally does not provide VFS: remote
 * filesystems have no synchronous filesystem surface.
 */
export const layer = (
	options: Options = {},
): Layer.Layer<SandboxIO.Provides | SandboxResource.Service, VercelError> => {
	const mounted = { ...options, cwd: SandboxIO.resolveMountCwd(DEFAULT_CWD, options.cwd) };
	return Layer.mergeAll(filesystemLayer(mounted), shellLayer(mounted), identityLayer(mounted), resourceLayer).pipe(
		Layer.provide(remote(mounted)),
	);
};

export const services = layer;

export * as EnvVercel from "./vercel.ts";
