import { type Effect, type Layer, Option, Schema } from "effect";
import type { SandboxProviderError } from "./errors.ts";
import { SandboxInstance } from "./instance.ts";
import { SandboxIO } from "./io.ts";

/** Version of the loadable sandbox-driver module ABI. */
export const apiVersion = 1 as const;
export type ApiVersion = typeof apiVersion;

/** Open driver identity. Adding a driver never extends a union in core. */
export const Name = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand("SandboxDriver.Name"));
export type Name = typeof Name.Type;

/** A path whose coordinate system is the mounted namespace. */
export const AbsolutePath = Schema.String.check(Schema.isStartsWith("/")).pipe(
	Schema.brand("SandboxDriver.AbsolutePath"),
);
export type AbsolutePath = typeof AbsolutePath.Type;

export const RuntimeConfigBase = Schema.Struct({ defaultCwd: AbsolutePath });
export interface RuntimeConfigBase extends Schema.Schema.Type<typeof RuntimeConfigBase> {}

export interface Capabilities {
	readonly inspect: boolean;
	readonly reattach: boolean;
	readonly wake: boolean;
	readonly stop: boolean;
	readonly destroy: boolean;
	readonly cancels: boolean;
}

export interface Observed {
	readonly status: SandboxInstance.Status;
	readonly providerStatus?: string | undefined;
	readonly metadata?: Readonly<Record<string, string>> | undefined;
}

export interface Provisioned<RuntimeConfig extends RuntimeConfigBase> {
	readonly providerResourceId?: string | undefined;
	readonly providerStatus?: string | undefined;
	readonly runtimeConfig: RuntimeConfig;
	readonly metadata?: Readonly<Record<string, string>> | undefined;
}

export interface RuntimeInput<RuntimeConfig extends RuntimeConfigBase> {
	readonly id: SandboxInstance.ID;
	readonly providerResourceId: Option.Option<string>;
	readonly runtimeConfig: RuntimeConfig;
}

export interface Driver<CreateConfig, RuntimeConfig extends RuntimeConfigBase> {
	readonly name: Name;
	readonly kind: Exclude<SandboxInstance.Kind, "local">;
	readonly capabilities: Capabilities;
	readonly createConfigCodec: Schema.Codec<CreateConfig, unknown>;
	readonly runtimeConfigCodec: Schema.Codec<RuntimeConfig, unknown>;
	readonly create: (input: {
		readonly instanceId: SandboxInstance.ID;
		readonly config: CreateConfig;
	}) => Effect.Effect<Provisioned<RuntimeConfig>, SandboxProviderError>;
	readonly runtimeConfigFor?:
		| ((input: {
				readonly providerResourceId: string;
				readonly overrides?: Partial<RuntimeConfig> | undefined;
		  }) => Effect.Effect<RuntimeConfig, SandboxProviderError>)
		| undefined;
	readonly attach: (
		input: RuntimeInput<RuntimeConfig>,
	) => Layer.Layer<SandboxIO.FileSystem | SandboxIO.Shell, SandboxProviderError>;
	readonly inspect?: (input: RuntimeInput<RuntimeConfig>) => Effect.Effect<Observed, SandboxProviderError>;
	readonly wake?: (input: RuntimeInput<RuntimeConfig>) => Effect.Effect<Observed, SandboxProviderError>;
	readonly stop?: (input: RuntimeInput<RuntimeConfig>) => Effect.Effect<Observed, SandboxProviderError>;
	readonly destroy?: (input: RuntimeInput<RuntimeConfig>) => Effect.Effect<void, SandboxProviderError>;
}

export type Definition<CreateConfig, RuntimeConfig extends RuntimeConfigBase> = Pick<
	Driver<CreateConfig, RuntimeConfig>,
	"name" | "createConfigCodec" | "runtimeConfigCodec"
>;

/** Registry-only erased shape. Driver authors construct it via {@link driver}. */
export interface Registered {
	readonly name: Name;
	readonly kind: Exclude<SandboxInstance.Kind, "local">;
	readonly capabilities: Capabilities;
	readonly createConfigCodec: Schema.Codec<unknown, unknown>;
	readonly runtimeConfigCodec: Schema.Codec<RuntimeConfigBase, unknown>;
	readonly create: (input: {
		readonly instanceId: SandboxInstance.ID;
		readonly config: unknown;
	}) => Effect.Effect<Provisioned<RuntimeConfigBase>, SandboxProviderError>;
	readonly runtimeConfigFor?:
		| ((input: {
				readonly providerResourceId: string;
				readonly overrides?: Readonly<Record<string, unknown>> | undefined;
		  }) => Effect.Effect<RuntimeConfigBase, SandboxProviderError>)
		| undefined;
	readonly attach: (
		input: RuntimeInput<RuntimeConfigBase>,
	) => Layer.Layer<SandboxIO.FileSystem | SandboxIO.Shell, SandboxProviderError>;
	readonly inspect?: (input: RuntimeInput<RuntimeConfigBase>) => Effect.Effect<Observed, SandboxProviderError>;
	readonly wake?: (input: RuntimeInput<RuntimeConfigBase>) => Effect.Effect<Observed, SandboxProviderError>;
	readonly stop?: (input: RuntimeInput<RuntimeConfigBase>) => Effect.Effect<Observed, SandboxProviderError>;
	readonly destroy?: (input: RuntimeInput<RuntimeConfigBase>) => Effect.Effect<void, SandboxProviderError>;
}

export const erase = <CreateConfig, RuntimeConfig extends RuntimeConfigBase>(
	value: Driver<CreateConfig, RuntimeConfig>,
): Registered => ({
	name: value.name,
	kind: value.kind,
	capabilities: value.capabilities,
	createConfigCodec: value.createConfigCodec as Schema.Codec<unknown, unknown>,
	runtimeConfigCodec: value.runtimeConfigCodec as Schema.Codec<RuntimeConfigBase, unknown>,
	create: (input) => value.create({ instanceId: input.instanceId, config: input.config as CreateConfig }),
	...(value.runtimeConfigFor === undefined
		? {}
		: {
				runtimeConfigFor: (input: {
					readonly providerResourceId: string;
					readonly overrides?: Readonly<Record<string, unknown>> | undefined;
				}) =>
					value.runtimeConfigFor!({
						providerResourceId: input.providerResourceId,
						...(input.overrides === undefined ? {} : { overrides: input.overrides as Partial<RuntimeConfig> }),
					}),
			}),
	attach: (input) => value.attach(input as RuntimeInput<RuntimeConfig>),
	...(value.inspect === undefined
		? {}
		: { inspect: (input: RuntimeInput<RuntimeConfigBase>) => value.inspect!(input as RuntimeInput<RuntimeConfig>) }),
	...(value.wake === undefined
		? {}
		: { wake: (input: RuntimeInput<RuntimeConfigBase>) => value.wake!(input as RuntimeInput<RuntimeConfig>) }),
	...(value.stop === undefined
		? {}
		: { stop: (input: RuntimeInput<RuntimeConfigBase>) => value.stop!(input as RuntimeInput<RuntimeConfig>) }),
	...(value.destroy === undefined
		? {}
		: { destroy: (input: RuntimeInput<RuntimeConfigBase>) => value.destroy!(input as RuntimeInput<RuntimeConfig>) }),
});

export type Source = "core" | "builtin" | "package" | "file";

export interface Registration {
	readonly registered: Registered;
	readonly apiVersion: ApiVersion;
	readonly source: Source;
}

export interface Module<Options> {
	readonly apiVersion: ApiVersion;
	readonly name: Name;
	readonly options: Schema.Codec<Options, unknown>;
	readonly make: (options: Options) => Registration;
}

export interface ModuleDefinition<Options> {
	readonly apiVersion: ApiVersion;
	readonly name: string | Name;
	readonly options: Schema.Codec<Options, unknown>;
	readonly make: (options: Options) => Registration;
}

/** Define the default export of a loadable sandbox package. */
const defineModule = <Options>(value: ModuleDefinition<Options>): Module<Options> => ({
	...value,
	name: Name.make(value.name),
});
export { defineModule as module };

/** Construct a driver and its registry contribution. */
export const driver = <CreateConfig, RuntimeConfig extends RuntimeConfigBase>(
	value: Driver<CreateConfig, RuntimeConfig>,
): Driver<CreateConfig, RuntimeConfig> & Registration =>
	Object.assign(value, {
		registered: erase(value),
		apiVersion,
		source: "builtin" as const,
	});

/** Attach trusted origin metadata without changing the driver implementation. */
export const withSource = (registration: Registration, source: Source): Registration => ({
	...registration,
	source,
});

export * as SandboxDriver from "./driver.ts";
