import type { VirtualFileSystem } from "@platformatic/vfs";
import { Effect, Layer, Option, Schema } from "effect";
import { fileSystem } from "../../host.ts";
import { posix } from "../../util/posix.ts";
import { SandboxDriver } from "../driver.ts";
import { providerError } from "../errors.ts";
import { SandboxInstance } from "../instance.ts";
import { EnvSqldb } from "../fs/sqldb.ts";
import { transport, transportLayer } from "../virtual.ts";

export interface RuntimeConfig extends SandboxDriver.RuntimeConfigBase {
	readonly location?: string | undefined;
	readonly inMemory: boolean;
}

export const CreateConfig = Schema.Struct({
	defaultCwd: Schema.optional(SandboxDriver.AbsolutePath),
	initializeCwd: Schema.optional(SandboxDriver.AbsolutePath),
	location: Schema.optional(Schema.String),
});
export type CreateConfig = typeof CreateConfig.Type;

export const RuntimeConfig = Schema.Struct({
	defaultCwd: SandboxDriver.AbsolutePath,
	location: Schema.optional(Schema.String),
	inMemory: Schema.Boolean,
});

interface MemoryResource {
	readonly provider: EnvSqldb.Namespace["provider"];
	readonly vfs: VirtualFileSystem;
}

export const make = () => {
	const name = SandboxDriver.Name.make("sqldb");
	const memory = new Map<SandboxInstance.ID, MemoryResource>();

	const runtimeLocation = (input: SandboxDriver.RuntimeInput<RuntimeConfig>) =>
		input.runtimeConfig.location ?? Option.getOrUndefined(input.providerResourceId);
	const persistentTransport = (location: string) => {
		const backend = EnvSqldb.layer({ location });
		return transportLayer(
			Layer.effectContext(
				Layer.build(backend).pipe(
					Effect.mapError((cause) => providerError({ driver: name, operation: "attach", cause })),
				),
			),
		);
	};

	const memoryResource = (operation: string, id: SandboxInstance.ID) => {
		const resource = memory.get(id);
		return resource === undefined
			? Effect.fail(
					providerError({
						driver: name,
						operation,
						cause: new Error(`in-memory sqlite namespace is unavailable in this process: ${id}`),
						notFound: true,
					}),
				)
			: Effect.succeed(resource);
	};

	const driver = SandboxDriver.driver<CreateConfig, RuntimeConfig>({
		name,
		kind: "virtual",
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
		create: ({ instanceId, config }) => {
			const defaultCwd = config.defaultCwd ?? SandboxDriver.AbsolutePath.make("/");
			const location = config.location === undefined ? undefined : posix.resolve(config.location);
			return EnvSqldb.make(location, { cwd: config.initializeCwd ?? defaultCwd }).pipe(
				Effect.mapError((cause) => providerError({ driver: name, operation: "create", cause })),
				Effect.map((namespace) => {
					if (location === undefined) memory.set(instanceId, namespace);
					else namespace.provider.close();
					return {
						...(location === undefined ? {} : { providerResourceId: location }),
						providerStatus: location === undefined ? "online" : "offline",
						runtimeConfig: {
							defaultCwd,
							...(location === undefined ? {} : { location }),
							inMemory: location === undefined,
						},
					};
				}),
			);
		},
		runtimeConfigFor: ({ providerResourceId, overrides }) => {
			if (!posix.isAbsolute(providerResourceId)) {
				return Effect.fail(
					providerError({
						driver: name,
						operation: "runtimeConfigFor",
						cause: new Error(`sqldb resource path must be absolute: ${providerResourceId}`),
					}),
				);
			}
			const location = posix.resolve(providerResourceId);
			return Effect.succeed({
				defaultCwd: overrides?.defaultCwd ?? SandboxDriver.AbsolutePath.make("/"),
				location,
				inMemory: false,
			});
		},
		attach: (input) => {
			if (input.runtimeConfig.inMemory) {
				return Layer.unwrap(Effect.map(memoryResource("attach", input.id), (resource) => transport(resource.vfs)));
			}
			const location = runtimeLocation(input);
			return location === undefined
				? Layer.unwrap(
						Effect.fail(
							providerError({
								driver: name,
								operation: "attach",
								cause: new Error(`sqldb runtime location is missing: ${input.id}`),
							}),
						),
					)
				: persistentTransport(location);
		},
		inspect: (input) => {
			if (input.runtimeConfig.inMemory) {
				return Effect.as(memoryResource("inspect", input.id), {
					status: "online" as const,
					providerStatus: "online",
				});
			}
			const location = runtimeLocation(input);
			if (location === undefined) {
				return Effect.fail(
					providerError({
						driver: name,
						operation: "inspect",
						cause: new Error(`sqldb runtime location is missing: ${input.id}`),
					}),
				);
			}
			return fileSystem.access(location).pipe(
				Effect.mapError((cause) => providerError({ driver: name, operation: "inspect", cause, notFound: true })),
				Effect.as({ status: "offline" as const, providerStatus: "closed" }),
			);
		},
		wake: (input) =>
			input.runtimeConfig.inMemory
				? Effect.as(memoryResource("wake", input.id), {
						status: "online" as const,
						providerStatus: "online",
					})
				: Effect.succeed({ status: "online", providerStatus: "open-on-attach" }),
		stop: (input) =>
			input.runtimeConfig.inMemory
				? Effect.as(memoryResource("stop", input.id), {
						status: "offline" as const,
						providerStatus: "retained",
					})
				: Effect.succeed({ status: "offline", providerStatus: "closed" }),
		destroy: (input) => {
			if (input.runtimeConfig.inMemory) {
				const resource = memory.get(input.id);
				if (resource !== undefined) resource.provider.close();
				memory.delete(input.id);
				return Effect.void;
			}
			const location = runtimeLocation(input);
			return location === undefined
				? Effect.fail(
						providerError({
							driver: name,
							operation: "destroy",
							cause: new Error(`sqldb runtime location is missing: ${input.id}`),
						}),
					)
				: fileSystem
						.remove(location, { force: true })
						.pipe(Effect.mapError((cause) => providerError({ driver: name, operation: "destroy", cause })));
		},
	});

	return { driver };
};

export * as SqldbSandboxDriver from "./sqldb.ts";
