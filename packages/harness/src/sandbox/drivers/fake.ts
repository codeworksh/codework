import type { VirtualFileSystem } from "@platformatic/vfs";
import { Effect, Layer, Option, Schema } from "effect";
import { SandboxDriver } from "../driver";
import { providerError, type SandboxProviderError } from "../errors";
import { EnvInMemory } from "../fs/inmemory";
import { SandboxFileSystem } from "../fs/filesystem";
import type { SandboxInstance } from "../instance";
import { Shell } from "../shell/shell";
import { transport } from "../virtual";

export interface CreateConfig {
	readonly defaultCwd?: SandboxDriver.AbsolutePath | undefined;
	readonly providerResourceId?: string | undefined;
}

export interface RuntimeConfig extends SandboxDriver.RuntimeConfigBase {
	readonly generation: number;
}

export const CreateConfig = Schema.Struct({
	defaultCwd: Schema.optional(SandboxDriver.AbsolutePath),
	providerResourceId: Schema.optional(Schema.String),
});

export const RuntimeConfig = Schema.Struct({
	defaultCwd: SandboxDriver.AbsolutePath,
	generation: Schema.Int,
});

export type Operation = "create" | "runtimeConfigFor" | "attach" | "inspect" | "wake" | "stop" | "destroy";

export interface Resource {
	readonly id: SandboxInstance.ID;
	readonly providerResourceId: string;
	readonly vfs: VirtualFileSystem;
	readonly runtimeConfig: RuntimeConfig;
	status: SandboxInstance.Status;
}

export interface State {
	readonly resources: Map<SandboxInstance.ID, Resource>;
	readonly calls: Record<Operation, Array<SandboxInstance.ID | string>>;
	readonly failNext: (operation: Operation, cause: unknown) => void;
	readonly blockNext: (operation: Operation, blocker: Effect.Effect<void>) => void;
	readonly remove: (id: SandboxInstance.ID) => void;
}

/**
 * A deterministic lifecycle driver for control-plane tests.
 *
 * Its namespace map belongs to the driver, not to an attachment, so unmount,
 * transport invalidation, and a fresh control plane all reattach to the same
 * in-memory filesystem. Every lifecycle operation can fail once on demand.
 */
export const make = (
	name: SandboxDriver.Name = SandboxDriver.Name.make("fake"),
): {
	readonly driver: SandboxDriver.Driver<CreateConfig, RuntimeConfig> & SandboxDriver.Registration;
	readonly state: State;
} => {
	const resources = new Map<SandboxInstance.ID, Resource>();
	const failures = new Map<Operation, unknown>();
	const blockers = new Map<Operation, Effect.Effect<void>>();
	const calls: State["calls"] = {
		create: [],
		runtimeConfigFor: [],
		attach: [],
		inspect: [],
		wake: [],
		stop: [],
		destroy: [],
	};

	const failNext = (operation: Operation, cause: unknown) => {
		failures.set(operation, cause);
	};

	const blockNext = (operation: Operation, blocker: Effect.Effect<void>) => {
		blockers.set(operation, blocker);
	};

	const attempted = <A>(
		operation: Operation,
		identity: SandboxInstance.ID | string,
		run: () => Effect.Effect<A, SandboxProviderError>,
	) => {
		calls[operation].push(identity);
		const cause = failures.get(operation);
		if (cause !== undefined) {
			failures.delete(operation);
			return Effect.fail(providerError({ driver: name, operation, cause }));
		}
		const blocker = blockers.get(operation);
		if (blocker === undefined) return run();
		blockers.delete(operation);
		return Effect.andThen(blocker, run());
	};

	const lookupInput = (operation: Operation, input: SandboxDriver.RuntimeInput<RuntimeConfig>) => {
		const providerResourceId = Option.getOrUndefined(input.providerResourceId);
		return attempted(operation, input.id, () => {
			const direct = resources.get(input.id);
			const resource =
				direct ??
				(providerResourceId === undefined
					? undefined
					: [...resources.values()].find((candidate) => candidate.providerResourceId === providerResourceId));
			return resource === undefined
				? Effect.fail(
						providerError({
							driver: name,
							operation,
							cause: new Error(`resource not found: ${input.id}`),
							notFound: true,
						}),
					)
				: Effect.succeed(resource);
		});
	};

	const driver = SandboxDriver.driver<CreateConfig, RuntimeConfig>({
		name,
		kind: "virtual",
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
			attempted("create", instanceId, () =>
				Effect.gen(function* () {
					const defaultCwd = config.defaultCwd ?? SandboxDriver.AbsolutePath.make("/");
					const runtimeConfig = { defaultCwd, generation: resources.size + 1 } satisfies RuntimeConfig;
					const providerResourceId = config.providerResourceId ?? `fake:${instanceId}`;
					const vfs = yield* EnvInMemory.make({ cwd: defaultCwd }).pipe(
						Effect.mapError((cause) => providerError({ driver: name, operation: "create", cause })),
					);
					resources.set(instanceId, {
						id: instanceId,
						providerResourceId,
						vfs,
						runtimeConfig,
						status: "online",
					});
					return {
						providerResourceId,
						providerStatus: "running",
						runtimeConfig,
					};
				}),
			),
		runtimeConfigFor: ({ providerResourceId, overrides }) =>
			attempted("runtimeConfigFor", providerResourceId, () => {
				const resource = [...resources.values()].find(
					(candidate) => candidate.providerResourceId === providerResourceId,
				);
				if (resource === undefined)
					return Effect.fail(
						providerError({
							driver: name,
							operation: "runtimeConfigFor",
							cause: new Error(`resource not found: ${providerResourceId}`),
							notFound: true,
						}),
					);
				return Effect.succeed({
					defaultCwd: overrides?.defaultCwd ?? resource.runtimeConfig.defaultCwd,
					generation: overrides?.generation ?? resource.runtimeConfig.generation,
				});
			}),
		attach: (input) =>
			Layer.unwrap(
				lookupInput("attach", input).pipe(
					Effect.flatMap((resource) => {
						if (resource.status === "removed" || resource.status === "unavail")
							return Effect.fail(
								providerError({
									driver: name,
									operation: "attach",
									cause: new Error(`resource not found: ${input.id}`),
									notFound: true,
								}),
							);
						resource.status = "online";
						return Effect.succeed(transport(resource.vfs));
					}),
				),
			),
		inspect: (input) =>
			Effect.map(lookupInput("inspect", input), (resource) => ({
				status: resource.status,
				providerStatus: resource.status,
			})),
		wake: (input) =>
			Effect.map(lookupInput("wake", input), (resource) => {
				resource.status = "online";
				return { status: "online" as const, providerStatus: "running" };
			}),
		stop: (input) =>
			Effect.map(lookupInput("stop", input), (resource) => {
				resource.status = "offline";
				return { status: "offline" as const, providerStatus: "stopped" };
			}),
		destroy: (input) =>
			Effect.asVoid(
				Effect.map(lookupInput("destroy", input), (resource) => {
					resource.status = "removed";
					resources.delete(resource.id);
				}),
			),
	});

	return {
		driver,
		state: {
			resources,
			calls,
			failNext,
			blockNext,
			remove: (id) => {
				resources.delete(id);
			},
		},
	};
};

export const io = Effect.gen(function* () {
	return {
		filesystem: yield* SandboxFileSystem.Service,
		shell: yield* Shell,
	};
});

export const providerResourceId = (resource: Resource) => Option.some(resource.providerResourceId);

export * as FakeSandboxDriver from "./fake";
