import type { VirtualFileSystem } from "@platformatic/vfs";
import { Effect, Layer, Option, Schema } from "effect";
import { SandboxDriver } from "../driver.ts";
import { providerError } from "../errors.ts";
import { EnvInMemory } from "../fs/inmemory.ts";
import { SandboxInstance } from "../instance.ts";
import { transport } from "../virtual.ts";

export interface CreateConfig {
	readonly defaultCwd: SandboxDriver.AbsolutePath;
	readonly initializeCwd?: SandboxDriver.AbsolutePath | undefined;
}

export interface RuntimeConfig extends SandboxDriver.RuntimeConfigBase {}

export const CreateConfig = Schema.Struct({
	defaultCwd: SandboxDriver.AbsolutePath,
	initializeCwd: Schema.optional(SandboxDriver.AbsolutePath),
});

export const RuntimeConfig = SandboxDriver.RuntimeConfigBase;

export interface MemoryDriver {
	readonly driver: SandboxDriver.Driver<CreateConfig, RuntimeConfig> & SandboxDriver.Registration;
}

export const make = (): MemoryDriver => {
	const name = SandboxDriver.Name.make("memory");
	const resources = new Map<SandboxInstance.ID, VirtualFileSystem>();

	const find = (operation: string, input: SandboxDriver.RuntimeInput<RuntimeConfig>) => {
		const vfs = resources.get(input.id);
		return vfs === undefined
			? Effect.fail(
					providerError({
						driver: name,
						operation,
						cause: new Error(`memory namespace is unavailable in this process: ${input.id}`),
						notFound: true,
					}),
				)
			: Effect.succeed(vfs);
	};

	const driver = SandboxDriver.driver<CreateConfig, RuntimeConfig>({
		name,
		kind: "virtual",
		capabilities: {
			reattach: false,
			wake: true,
			stop: true,
			destroy: true,
			cancels: true,
		},
		createConfigCodec: CreateConfig,
		runtimeConfigCodec: RuntimeConfig,
		create: ({ instanceId, config }) =>
			EnvInMemory.make({ cwd: config.initializeCwd ?? config.defaultCwd }).pipe(
				Effect.mapError((cause) => providerError({ driver: name, operation: "create", cause })),
				Effect.map((vfs) => {
					resources.set(instanceId, vfs);
					return {
						providerResourceId: `memory:${instanceId}`,
						providerStatus: "online",
						runtimeConfig: { defaultCwd: config.defaultCwd },
					};
				}),
			),
		runtimeConfigFor: ({ providerResourceId }) =>
			Effect.fail(
				providerError({
					driver: name,
					operation: "runtimeConfigFor",
					cause: new Error(`memory resources cannot be reattached: ${providerResourceId}`),
					notFound: true,
				}),
			),
		attach: (input) => Layer.unwrap(Effect.map(find("attach", input), transport)),
		inspect: (input) =>
			Effect.as(find("inspect", input), {
				status: "online",
				providerStatus: "online",
			}),
		wake: (input) =>
			Effect.as(find("wake", input), {
				status: "online",
				providerStatus: "online",
			}),
		stop: (input) =>
			Effect.as(find("stop", input), {
				status: "offline" as const,
				providerStatus: "retained",
			}),
		destroy: (input) =>
			Effect.suspend(() => {
				const existed = resources.delete(input.id);
				return existed || Option.isSome(input.providerResourceId)
					? Effect.void
					: Effect.fail(
							providerError({
								driver: name,
								operation: "destroy",
								cause: new Error(`memory namespace is unavailable: ${input.id}`),
								notFound: true,
							}),
						);
			}),
	});

	return { driver };
};

export * as MemorySandboxDriver from "./memory.ts";
