/* Vendored example of a third-party sandbox package; it only uses the public driver SDK. */
/* oxlint-disable effecttsgo/async-function -- Vercel's SDK boundary is Promise-based. */
import {
	SandboxDriver,
	SandboxFileSystem,
	SandboxIO,
	SandboxProvider,
	SandboxShell,
} from "@codeworksh/harness/sandbox";
import { Effect, Layer, Option, Schema } from "effect";
import { Buffer } from "node:buffer";

export const Options = Schema.Struct({
	token: Schema.optional(Schema.String),
	teamId: Schema.optional(Schema.String),
	projectId: Schema.optional(Schema.String),
});
export type Options = typeof Options.Type;

export const CreateConfig = Schema.Struct({
	snapshot: Schema.optional(Schema.String),
	runtime: Schema.optional(Schema.String),
	envVars: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	timeout: Schema.optional(Schema.Finite),
	execTimeout: Schema.optional(Schema.Finite),
});
export type CreateConfig = typeof CreateConfig.Type;

export const RuntimeConfig = Schema.Struct({
	defaultCwd: SandboxDriver.AbsolutePath,
	execTimeout: Schema.optional(Schema.Finite),
});
export type RuntimeConfig = typeof RuntimeConfig.Type;

type Remote = import("@vercel/sandbox").Sandbox;
type Command = import("@vercel/sandbox").Command;

const name = SandboxDriver.Name.make("codework.test.vercel");
const defaultCwd = "/vercel/sandbox";

const credentials = (options: Options) =>
	options.token !== undefined && options.teamId !== undefined && options.projectId !== undefined
		? { token: options.token, teamId: options.teamId, projectId: options.projectId }
		: undefined;

const status = (remote: Remote): SandboxDriver.Observed => ({
	status:
		remote.status === "stopped"
			? "offline"
			: remote.status === "failed" || remote.status === "aborted"
				? "faulted"
				: remote.status === "stopping" || remote.status === "snapshotting"
					? "suspending"
					: "online",
	providerStatus: remote.status,
});

const filesystem = (remote: Remote): SandboxFileSystem.Interface =>
	SandboxFileSystem.fromProvider({
		readFile: (path) => remote.fs.readFile(path, "utf8"),
		readFileBuffer: async (path) => new Uint8Array(await remote.fs.readFile(path)),
		writeFile: (path, content) =>
			remote.fs.writeFile(path, typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content)),
		stat: async (path) => {
			const value = await remote.fs.stat(path);
			return {
				isFile: value.isFile(),
				isDirectory: value.isDirectory(),
				isSymbolicLink: value.isSymbolicLink(),
				...(Number.isFinite(value.size) ? { size: value.size } : {}),
				...(Number.isNaN(value.mtime.getTime()) ? {} : { mtime: value.mtime }),
			};
		},
		readdir: async (path) => (await remote.fs.readdir(path, { withFileTypes: true })).map((entry) => entry.name),
		exists: async (path) => {
			try {
				await remote.fs.stat(path);
				return true;
			} catch (cause) {
				if (SandboxFileSystem.isNotFoundError(cause)) return false;
				throw cause;
			}
		},
		mkdir: async (path, options) => {
			await remote.fs.mkdir(path, options?.recursive === undefined ? {} : { recursive: options.recursive });
		},
		rm: (path, options) => remote.fs.rm(path, options),
	});

const command = (
	remote: Remote,
	execTimeout: number | undefined,
	argv: ReadonlyArray<string>,
	options?: SandboxShell.ShellOptions,
): Promise<Command> =>
	remote.runCommand({
		cmd: argv[0]!,
		args: argv.slice(1),
		...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
		...(options?.env === undefined ? {} : { env: options.env }),
		detached: true,
		...(execTimeout === undefined ? {} : { timeoutMs: execTimeout }),
	});

const execute = (
	remote: Remote,
	execTimeout: number | undefined,
	argv: ReadonlyArray<string>,
	options?: SandboxShell.ShellOptions,
) => {
	const label = SandboxShell.quoteArgv(argv);
	return Effect.acquireRelease(
		Effect.tryPromise({
			try: () => command(remote, execTimeout, argv, options),
			catch: (cause) => new SandboxShell.ShellError({ command: label, cause }),
		}),
		(value) => Effect.promise(() => value.kill("SIGKILL").catch(() => {})),
	).pipe(
		Effect.flatMap((value) =>
			Effect.tryPromise({
				try: async () => {
					const result = await value.wait();
					const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
					return { stdout, stderr, exitCode: result.exitCode };
				},
				catch: (cause) => new SandboxShell.ShellError({ command: label, cause }),
			}),
		),
		Effect.scoped,
	);
};

const shell = (remote: Remote, execTimeout: number | undefined): SandboxShell.ISandboxExe => ({
	exec: (value, options) => execute(remote, execTimeout, ["sh", "-c", value], options),
	execArgv: (argv, options) => execute(remote, execTimeout, argv, options),
});

export const make = (options: Options = {}) => {
	const auth = credentials(options);
	const redact = SandboxProvider.makeRedactor([options.token ?? ""]);
	const attempt = <A>(operation: string, run: () => Promise<A>) =>
		Effect.tryPromise({
			try: run,
			catch: (cause) => SandboxProvider.providerError({ driver: name, operation, cause, redact }),
		});
	const get = (providerResourceId: string, resume: boolean, operation: string) =>
		attempt(operation, () =>
			import("@vercel/sandbox").then(({ Sandbox }) =>
				Sandbox.get(
					auth === undefined
						? { name: providerResourceId, resume }
						: { ...auth, name: providerResourceId, resume },
				),
			),
		);

	return SandboxDriver.driver<CreateConfig, RuntimeConfig>({
		name,
		kind: "remote",
		capabilities: {
			inspect: true,
			reattach: true,
			wake: true,
			stop: true,
			destroy: true,
			cancels: true,
		},
		createConfigCodec: CreateConfig,
		runtimeConfigCodec: RuntimeConfig,
		create: ({ instanceId, config }) =>
			attempt("create", async () => {
				const { Sandbox } = await import("@vercel/sandbox");
				const base = {
					...(config.envVars === undefined ? {} : { env: config.envVars }),
					...(config.timeout === undefined ? {} : { timeout: config.timeout }),
					tags: { "codework-instance": instanceId, "codework-managed": "true", "codework-test": "true" },
				};
				const remote =
					config.snapshot === undefined
						? await Sandbox.create({
								...base,
								...auth,
								...(config.runtime === undefined ? {} : { runtime: config.runtime }),
							})
						: await Sandbox.create({
								...base,
								...auth,
								source: { type: "snapshot", snapshotId: config.snapshot },
							});
				return {
					providerResourceId: remote.name,
					providerStatus: remote.status,
					runtimeConfig: {
						defaultCwd: SandboxDriver.AbsolutePath.make(remote.cwd || defaultCwd),
						...(config.execTimeout === undefined ? {} : { execTimeout: config.execTimeout }),
					},
				};
			}),
		runtimeConfigFor: ({ providerResourceId, overrides }) =>
			Effect.map(get(providerResourceId, false, "runtimeConfigFor"), (remote) => ({
				defaultCwd: overrides?.defaultCwd ?? SandboxDriver.AbsolutePath.make(remote.cwd || defaultCwd),
				...(overrides?.execTimeout === undefined ? {} : { execTimeout: overrides.execTimeout }),
			})),
		attach: (input) =>
			Layer.unwrap(
				Effect.map(
					get(
						Option.getOrElse(input.providerResourceId, () => input.id),
						true,
						"attach",
					),
					(remote) =>
						Layer.merge(
							Layer.succeed(SandboxIO.FileSystem, filesystem(remote)),
							Layer.succeed(SandboxIO.Shell, shell(remote, input.runtimeConfig.execTimeout)),
						),
				),
			),
		inspect: (input) =>
			Effect.map(
				get(
					Option.getOrElse(input.providerResourceId, () => input.id),
					false,
					"inspect",
				),
				status,
			),
		wake: (input) =>
			Effect.map(
				get(
					Option.getOrElse(input.providerResourceId, () => input.id),
					true,
					"wake",
				),
				status,
			),
		stop: (input) =>
			Effect.flatMap(
				get(
					Option.getOrElse(input.providerResourceId, () => input.id),
					false,
					"stop",
				),
				(remote) =>
					attempt("stop", () => remote.stop()).pipe(
						Effect.as({ status: "offline" as const, providerStatus: "stopped" }),
					),
			),
		destroy: (input) =>
			Effect.flatMap(
				get(
					Option.getOrElse(input.providerResourceId, () => input.id),
					false,
					"destroy",
				),
				(remote) => attempt("destroy", () => remote.delete()),
			),
	});
};

export default SandboxDriver.module({
	apiVersion: SandboxDriver.apiVersion,
	name,
	options: Options,
	make,
});
