import { Sandbox as RemoteSandbox } from "@vercel/sandbox";
import { Effect, Layer, Option, Schema } from "effect";
import { SandboxDriver } from "../driver.ts";
import { makeRedactor, providerError, type SandboxProviderError } from "../errors.ts";
import { SandboxInstance } from "../instance.ts";
import { EnvVercel } from "../providers/vercel.ts";

export interface ClientOptions {
	readonly token?: string | undefined;
	readonly teamId?: string | undefined;
	readonly projectId?: string | undefined;
}

export const Source = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("git"),
		url: Schema.String,
		revision: Schema.optional(Schema.String),
		depth: Schema.optional(Schema.Finite),
	}),
	Schema.Struct({
		type: Schema.Literal("tarball"),
		url: Schema.String,
	}),
]);
export type Source = typeof Source.Type;

export const CreateConfig = Schema.Struct({
	snapshot: Schema.optional(Schema.String),
	source: Schema.optional(Source),
	runtime: Schema.optional(Schema.String),
	ports: Schema.optional(Schema.Array(Schema.Finite)),
	envVars: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	vcpus: Schema.optional(Schema.Finite),
	timeout: Schema.optional(Schema.Finite),
	execTimeout: Schema.optional(Schema.Finite),
});
export type CreateConfig = typeof CreateConfig.Type;

export const RuntimeConfig = Schema.Struct({
	defaultCwd: SandboxDriver.AbsolutePath,
	execTimeout: Schema.optional(Schema.Finite),
});
export type RuntimeConfig = typeof RuntimeConfig.Type;

const name = SandboxDriver.Name.make("vercel");

const statusFrom = (
	status: RemoteSandbox["status"],
): {
	readonly status: SandboxInstance.Status;
	readonly providerStatus: string;
} => ({
	status:
		status === "stopped"
			? "offline"
			: status === "stopping" || status === "snapshotting"
				? "suspending"
				: status === "failed" || status === "aborted"
					? "faulted"
					: "online",
	providerStatus: status,
});

const isNotFound = (cause: unknown): boolean => {
	if (typeof cause !== "object" || cause === null) return false;
	const response = "response" in cause && cause.response instanceof Response ? cause.response : undefined;
	const code =
		"code" in cause && typeof cause.code === "string"
			? cause.code
			: "json" in cause &&
				  typeof cause.json === "object" &&
				  cause.json !== null &&
				  "error" in cause.json &&
				  typeof cause.json.error === "object" &&
				  cause.json.error !== null &&
				  "code" in cause.json.error &&
				  typeof cause.json.error.code === "string"
				? cause.json.error.code
				: undefined;
	return response?.status === 404 || code === "not_found" || code === "sandbox_not_found";
};

export const make = (
	client: ClientOptions = {},
): SandboxDriver.Driver<CreateConfig, RuntimeConfig> & SandboxDriver.Registration => {
	const credentials = EnvVercel.credentialsFrom(client);
	const redact = makeRedactor([client.token ?? ""]);

	const attempt = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, SandboxProviderError> =>
		Effect.tryPromise({
			try: run,
			catch: (cause) =>
				providerError({
					driver: name,
					operation,
					cause,
					redact,
					notFound: isNotFound(cause),
				}),
		});

	const get = (providerResourceId: string, resume: boolean, operation: string) =>
		attempt(operation, () =>
			RemoteSandbox.get(
				credentials === undefined
					? { name: providerResourceId, resume }
					: { ...credentials, name: providerResourceId, resume },
			),
		);

	const observed = (sandbox: RemoteSandbox): SandboxDriver.Observed => ({
		...statusFrom(sandbox.status),
		metadata: {
			cwd: sandbox.cwd,
		},
	});

	return SandboxDriver.driver({
		name,
		kind: "remote",
		capabilities: {
			reattach: true,
			wake: true,
			stop: true,
			destroy: true,
			cancels: true,
		},
		createConfigCodec: CreateConfig,
		runtimeConfigCodec: RuntimeConfig,
		create: ({ instanceId, config }) =>
			Effect.gen(function* () {
				const source =
					config.source?.type === "git"
						? {
								type: "git" as const,
								url: config.source.url,
								...(config.source.revision === undefined ? {} : { revision: config.source.revision }),
								...(config.source.depth === undefined ? {} : { depth: config.source.depth }),
							}
						: config.source;
				const sandbox = yield* attempt("create", () =>
					EnvVercel.createSandbox(
						{
							...client,
							...(config.snapshot === undefined ? {} : { snapshot: config.snapshot }),
							...(source === undefined ? {} : { source }),
							...(config.runtime === undefined ? {} : { runtime: config.runtime }),
							...(config.ports === undefined ? {} : { ports: [...config.ports] }),
							...(config.envVars === undefined ? {} : { envVars: config.envVars }),
							...(config.vcpus === undefined ? {} : { vcpus: config.vcpus }),
							...(config.timeout === undefined ? {} : { timeout: config.timeout }),
							...(config.execTimeout === undefined ? {} : { execTimeout: config.execTimeout }),
							tags: {
								"codework-instance": instanceId,
								"codework-managed": "true",
							},
						},
						credentials,
					),
				);
				const state = statusFrom(sandbox.status);
				return {
					providerResourceId: sandbox.name,
					providerStatus: state.providerStatus,
					runtimeConfig: {
						defaultCwd: SandboxDriver.AbsolutePath.make(sandbox.cwd || EnvVercel.DEFAULT_CWD),
						...(config.execTimeout === undefined ? {} : { execTimeout: config.execTimeout }),
					},
					metadata: {
						cwd: sandbox.cwd,
					},
				};
			}),
		runtimeConfigFor: ({ providerResourceId, overrides }) =>
			Effect.map(get(providerResourceId, false, "runtimeConfigFor"), (sandbox) => ({
				defaultCwd: overrides?.defaultCwd ?? SandboxDriver.AbsolutePath.make(sandbox.cwd || EnvVercel.DEFAULT_CWD),
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
					(sandbox) =>
						EnvVercel.transport(
							sandbox,
							input.runtimeConfig.execTimeout === undefined
								? undefined
								: { execTimeout: input.runtimeConfig.execTimeout },
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
				observed,
			),
		wake: (input) =>
			Effect.map(
				get(
					Option.getOrElse(input.providerResourceId, () => input.id),
					true,
					"wake",
				),
				observed,
			),
		stop: (input) =>
			Effect.flatMap(
				get(
					Option.getOrElse(input.providerResourceId, () => input.id),
					false,
					"stop",
				),
				(sandbox) => attempt("stop", () => sandbox.stop()).pipe(Effect.map(() => observed(sandbox))),
			),
		destroy: (input) =>
			Effect.flatMap(
				get(
					Option.getOrElse(input.providerResourceId, () => input.id),
					false,
					"destroy",
				),
				(sandbox) => attempt("destroy", () => sandbox.delete()),
			),
	});
};

export * as VercelSandboxDriver from "./vercel.ts";
