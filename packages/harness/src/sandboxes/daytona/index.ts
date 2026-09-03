import { Effect, Layer, Option, Schema } from "effect";
import { SandboxDriver, SandboxInstance, SandboxProvider } from "../../sandbox.ts";
import * as EnvDaytona from "./provider.ts";

export const Options = Schema.Struct({
	apiKey: Schema.optional(Schema.String),
	apiUrl: Schema.optional(Schema.String),
	target: Schema.optional(Schema.String),
});
export type Options = typeof Options.Type;
export const ClientOptions = Options;
export type ClientOptions = Options;

export const ResourcesConfig = Schema.Struct({
	cpu: Schema.optional(Schema.Finite),
	gpu: Schema.optional(Schema.Finite),
	memory: Schema.optional(Schema.Finite),
	disk: Schema.optional(Schema.Finite),
});
export type ResourcesConfig = typeof ResourcesConfig.Type;

export const CreateConfig = Schema.Struct({
	snapshot: Schema.optional(Schema.String),
	image: Schema.optional(Schema.String),
	language: Schema.optional(Schema.String),
	envVars: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	resources: Schema.optional(ResourcesConfig),
	user: Schema.optional(Schema.String),
	cwd: Schema.optional(Schema.String),
	autoStopInterval: Schema.optional(Schema.Finite),
	execTimeout: Schema.optional(Schema.Finite),
});
export type CreateConfig = typeof CreateConfig.Type;

export const RuntimeConfig = Schema.Struct({
	defaultCwd: SandboxDriver.AbsolutePath,
	user: Schema.optional(Schema.String),
	execTimeout: Schema.optional(Schema.Finite),
});
export type RuntimeConfig = typeof RuntimeConfig.Type;

const name = SandboxDriver.Name.make("daytona");
type DaytonaSdk = typeof import("@daytona/sdk");
type RemoteSandbox = import("@daytona/sdk").Sandbox;
type Resources = import("@daytona/sdk").Resources;

const statusFrom = (
	state: RemoteSandbox["state"],
): {
	readonly status: SandboxInstance.Status;
	readonly providerStatus: string;
} => {
	const providerStatus = state ?? "unknown";
	return {
		status:
			state === "stopped" || state === "archived"
				? "offline"
				: state === "stopping" || state === "archiving" || state === "snapshotting" || state === "destroying"
					? "suspending"
					: state === "destroyed"
						? "unavail"
						: state === "error" || state === "build_failed" || state === "unknown"
							? "faulted"
							: "online",
		providerStatus,
	};
};

const shouldWake = (sandbox: RemoteSandbox): boolean => sandbox.state === "stopped" || sandbox.state === "archived";

export const make = (
	client: ClientOptions = {},
): SandboxDriver.Driver<CreateConfig, RuntimeConfig> & SandboxDriver.Registration => {
	const redact = SandboxProvider.makeRedactor([client.apiKey ?? ""]);
	const daytona = (sdk: DaytonaSdk) =>
		new sdk.Daytona({
			...(client.apiKey === undefined ? {} : { apiKey: client.apiKey }),
			...(client.apiUrl === undefined ? {} : { apiUrl: client.apiUrl }),
			...(client.target === undefined ? {} : { target: client.target }),
		});

	const attempt = <A>(
		operation: string,
		run: (sdk: DaytonaSdk) => Promise<A>,
	): Effect.Effect<A, SandboxProvider.SandboxProviderError> =>
		Effect.suspend(() => {
			let sdk: DaytonaSdk | undefined;
			return Effect.tryPromise({
				try: () =>
					import("@daytona/sdk").then((loaded) => {
						sdk = loaded;
						return run(loaded);
					}),
				catch: (cause) =>
					SandboxProvider.providerError({
						driver: name,
						operation,
						cause,
						redact,
						notFound: sdk !== undefined && cause instanceof sdk.DaytonaNotFoundError,
					}),
			});
		});

	const get = (providerResourceId: string, operation: string) =>
		attempt(operation, (sdk) => daytona(sdk).get(providerResourceId));

	const refresh = (sandbox: RemoteSandbox, operation: string) =>
		attempt(operation, () => sandbox.refreshData()).pipe(Effect.as(sandbox));

	const observed = (sandbox: RemoteSandbox): SandboxDriver.Observed => ({
		...statusFrom(sandbox.state),
		metadata: {
			target: sandbox.target,
		},
	});

	const wake = (sandbox: RemoteSandbox, operation: string) =>
		shouldWake(sandbox)
			? attempt(operation, () => sandbox.start()).pipe(Effect.map(() => sandbox))
			: Effect.succeed(sandbox);

	const runtime = (
		defaultCwd: string,
		input: { readonly user?: string | undefined; readonly execTimeout?: number | undefined },
	) => ({
		defaultCwd: SandboxDriver.AbsolutePath.make(defaultCwd),
		...(input.user === undefined ? {} : { user: input.user }),
		...(input.execTimeout === undefined ? {} : { execTimeout: input.execTimeout }),
	});

	return SandboxDriver.driver({
		name,
		kind: "remote",
		capabilities: {
			inspect: true,
			reattach: true,
			wake: true,
			stop: true,
			destroy: true,
			// Installed SDK 0.187.0 has no cancellation signal on
			// executeCommand; session execution cannot carry cwd/env safely.
			cancels: false,
		},
		createConfigCodec: CreateConfig,
		runtimeConfigCodec: RuntimeConfig,
		create: ({ instanceId, config }) =>
			Effect.gen(function* () {
				const base = {
					language: config.language ?? "typescript",
					...(config.envVars === undefined ? {} : { envVars: config.envVars }),
					...(config.user === undefined ? {} : { user: config.user }),
					...(config.autoStopInterval === undefined ? {} : { autoStopInterval: config.autoStopInterval }),
					autoDeleteInterval: -1,
					labels: {
						"codework-instance": instanceId,
						"codework-managed": "true",
					},
				};
				const sandbox = yield* attempt("create", (loaded) => {
					const sdk = daytona(loaded);
					return config.image === undefined
						? sdk.create({ ...base, ...(config.snapshot === undefined ? {} : { snapshot: config.snapshot }) })
						: sdk.create({
								...base,
								image: config.image,
								...(config.resources === undefined ? {} : { resources: config.resources as Resources }),
							});
				});
				const defaultCwd = yield* attempt("create.cwd", () =>
					EnvDaytona.mountCwd(config.cwd, () => sandbox.getWorkDir()),
				);
				const state = statusFrom(sandbox.state);
				return {
					providerResourceId: sandbox.id,
					providerStatus: state.providerStatus,
					runtimeConfig: runtime(defaultCwd, config),
					metadata: {
						target: sandbox.target,
					},
				};
			}),
		runtimeConfigFor: ({ providerResourceId, overrides }) =>
			Effect.gen(function* () {
				const sandbox = yield* get(providerResourceId, "runtimeConfigFor");
				const defaultCwd =
					overrides?.defaultCwd ??
					SandboxDriver.AbsolutePath.make(
						yield* attempt("runtimeConfigFor.cwd", () =>
							EnvDaytona.mountCwd(undefined, () => sandbox.getWorkDir()),
						),
					);
				return {
					defaultCwd,
					...(overrides?.user === undefined ? { user: sandbox.user } : { user: overrides.user }),
					...(overrides?.execTimeout === undefined ? {} : { execTimeout: overrides.execTimeout }),
				};
			}),
		attach: (input) =>
			Layer.unwrap(
				Effect.gen(function* () {
					const sandbox = yield* get(
						Option.getOrElse(input.providerResourceId, () => input.id),
						"attach",
					);
					yield* wake(sandbox, "attach.wake");
					return EnvDaytona.transport(
						sandbox,
						input.runtimeConfig.execTimeout === undefined
							? undefined
							: { execTimeout: input.runtimeConfig.execTimeout },
					);
				}),
			),
		inspect: (input) =>
			Effect.flatMap(
				get(
					Option.getOrElse(input.providerResourceId, () => input.id),
					"inspect",
				),
				(sandbox) => Effect.map(refresh(sandbox, "inspect.refresh"), observed),
			),
		wake: (input) =>
			Effect.flatMap(
				get(
					Option.getOrElse(input.providerResourceId, () => input.id),
					"wake",
				),
				(sandbox) => Effect.map(wake(sandbox, "wake.start"), observed),
			),
		stop: (input) =>
			Effect.flatMap(
				get(
					Option.getOrElse(input.providerResourceId, () => input.id),
					"stop",
				),
				(sandbox) => attempt("stop", () => sandbox.stop()).pipe(Effect.map(() => observed(sandbox))),
			),
		destroy: (input) =>
			Effect.flatMap(
				get(
					Option.getOrElse(input.providerResourceId, () => input.id),
					"destroy",
				),
				(sandbox) => attempt("destroy", () => sandbox.delete()),
			),
	});
};

const sandbox = SandboxDriver.module({
	apiVersion: SandboxDriver.apiVersion,
	name,
	options: Options,
	make,
});

export const config = (value: CreateConfig) => ({ driver: "daytona" as const, config: value });

export default sandbox;
