import { Context, Effect, Layer, Option, Schema } from "effect";
import { SandboxDriverNotRegisteredError, SandboxDriverRegistrationError, type SandboxProviderError } from "./errors";
import { SandboxInstance } from "./instance";
import { SandboxIO } from "./io";

/** Open driver identity. Adding a driver never extends a union in core. */
export const Name = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand("SandboxDriver.Name"));
export type Name = typeof Name.Type;

/** A path whose coordinate system is the mounted namespace. */
export const AbsolutePath = Schema.String.check(Schema.isStartsWith("/")).pipe(
	Schema.brand("SandboxDriver.AbsolutePath"),
);
export type AbsolutePath = typeof AbsolutePath.Type;

export const RuntimeConfigBase = Schema.Struct({
	defaultCwd: AbsolutePath,
});
export interface RuntimeConfigBase extends Schema.Schema.Type<typeof RuntimeConfigBase> {}

export interface Capabilities {
	readonly reattach: boolean;
	readonly wake: boolean;
	readonly stop: boolean;
	readonly destroy: boolean;
	readonly cancels: boolean;
}

export interface Observed {
	readonly status: SandboxInstance.Status;
	readonly providerStatus?: string;
	readonly metadata?: Readonly<Record<string, string>>;
}

export interface Provisioned<RuntimeConfig extends RuntimeConfigBase> {
	readonly providerResourceId?: string;
	readonly providerStatus?: string;
	readonly runtimeConfig: RuntimeConfig;
	readonly metadata?: Readonly<Record<string, string>>;
}

export interface RuntimeInput<RuntimeConfig extends RuntimeConfigBase> {
	readonly id: SandboxInstance.ID;
	readonly providerResourceId: Option.Option<string>;
	readonly runtimeConfig: RuntimeConfig;
}

export interface Driver<CreateConfig, RuntimeConfig extends RuntimeConfigBase> {
	readonly name: Name;
	readonly kind: SandboxInstance.Kind;
	readonly capabilities: Capabilities;
	readonly createConfigCodec: Schema.Codec<CreateConfig, unknown>;
	readonly runtimeConfigCodec: Schema.Codec<RuntimeConfig, unknown>;

	readonly create: (input: {
		readonly instanceId: SandboxInstance.ID;
		readonly config: CreateConfig;
	}) => Effect.Effect<Provisioned<RuntimeConfig>, SandboxProviderError>;

	readonly runtimeConfigFor: (input: {
		readonly providerResourceId: string;
		readonly overrides?: Partial<RuntimeConfig>;
	}) => Effect.Effect<RuntimeConfig, SandboxProviderError>;

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

/**
 * The registry's type-erased shape. Erasure happens once at registration;
 * untrusted values still cross the registered driver's codecs before reaching
 * its typed implementation.
 */
export interface Registered {
	readonly name: Name;
	readonly kind: SandboxInstance.Kind;
	readonly capabilities: Capabilities;
	readonly createConfigCodec: Schema.Codec<unknown, unknown>;
	readonly runtimeConfigCodec: Schema.Codec<RuntimeConfigBase, unknown>;
	readonly create: (input: {
		readonly instanceId: SandboxInstance.ID;
		readonly config: unknown;
	}) => Effect.Effect<Provisioned<RuntimeConfigBase>, SandboxProviderError>;
	readonly runtimeConfigFor: (input: {
		readonly providerResourceId: string;
		readonly overrides?: Readonly<Record<string, unknown>>;
	}) => Effect.Effect<RuntimeConfigBase, SandboxProviderError>;
	readonly attach: (
		input: RuntimeInput<RuntimeConfigBase>,
	) => Layer.Layer<SandboxIO.FileSystem | SandboxIO.Shell, SandboxProviderError>;
	readonly inspect?: (input: RuntimeInput<RuntimeConfigBase>) => Effect.Effect<Observed, SandboxProviderError>;
	readonly wake?: (input: RuntimeInput<RuntimeConfigBase>) => Effect.Effect<Observed, SandboxProviderError>;
	readonly stop?: (input: RuntimeInput<RuntimeConfigBase>) => Effect.Effect<Observed, SandboxProviderError>;
	readonly destroy?: (input: RuntimeInput<RuntimeConfigBase>) => Effect.Effect<void, SandboxProviderError>;
}

const erase = <CreateConfig, RuntimeConfig extends RuntimeConfigBase>(
	driver: Driver<CreateConfig, RuntimeConfig>,
): Registered => ({
	name: driver.name,
	kind: driver.kind,
	capabilities: driver.capabilities,
	createConfigCodec: driver.createConfigCodec as Schema.Codec<unknown, unknown>,
	runtimeConfigCodec: driver.runtimeConfigCodec as Schema.Codec<RuntimeConfigBase, unknown>,
	create: (input) => driver.create({ instanceId: input.instanceId, config: input.config as CreateConfig }),
	runtimeConfigFor: (input) =>
		driver.runtimeConfigFor({
			providerResourceId: input.providerResourceId,
			overrides: input.overrides as Partial<RuntimeConfig> | undefined,
		}),
	attach: (input) => driver.attach(input as RuntimeInput<RuntimeConfig>),
	...(driver.inspect === undefined
		? {}
		: { inspect: (input: RuntimeInput<RuntimeConfigBase>) => driver.inspect!(input as RuntimeInput<RuntimeConfig>) }),
	...(driver.wake === undefined
		? {}
		: { wake: (input: RuntimeInput<RuntimeConfigBase>) => driver.wake!(input as RuntimeInput<RuntimeConfig>) }),
	...(driver.stop === undefined
		? {}
		: { stop: (input: RuntimeInput<RuntimeConfigBase>) => driver.stop!(input as RuntimeInput<RuntimeConfig>) }),
	...(driver.destroy === undefined
		? {}
		: { destroy: (input: RuntimeInput<RuntimeConfigBase>) => driver.destroy!(input as RuntimeInput<RuntimeConfig>) }),
});

export interface RegistryService {
	readonly names: ReadonlySet<Name>;
	readonly find: (name: Name) => Option.Option<Registered>;
	readonly get: (name: Name) => Effect.Effect<Registered, SandboxDriverNotRegisteredError>;
	readonly decodeCreateConfig: (
		name: Name,
		input: unknown,
	) => Effect.Effect<unknown, SandboxDriverNotRegisteredError | SandboxDriverRegistrationError>;
	readonly decodeRuntimeConfig: (
		name: Name,
		input: unknown,
	) => Effect.Effect<RuntimeConfigBase, SandboxDriverNotRegisteredError | SandboxDriverRegistrationError>;
	readonly encodeRuntimeConfig: (
		name: Name,
		input: RuntimeConfigBase,
	) => Effect.Effect<unknown, SandboxDriverNotRegisteredError | SandboxDriverRegistrationError>;
}

export class Registry extends Context.Service<Registry, RegistryService>()("@codework/sandbox/driver/registry") {}

const codecFailure = (driver: Name, reason: unknown) =>
	new SandboxDriverRegistrationError({ driver, reason: String(reason) });

export interface Registration {
	readonly registered: Registered;
}

/**
 * Creates in-memory driver registry map and throws for invalid state operations.
 * Exposes registry services methods to work with.
 */
export const makeRegistry = (
	drivers: ReadonlyArray<Registration>,
): Effect.Effect<RegistryService, SandboxDriverRegistrationError> =>
	Effect.gen(function* () {
		const entries = new Map<Name, Registered>();
		for (const registration of drivers) {
			const driver = registration.registered;
			if (entries.has(driver.name)) {
				return yield* new SandboxDriverRegistrationError({
					driver: driver.name,
					reason: "duplicate driver registration",
				});
			}
			if (driver.capabilities.destroy && !driver.capabilities.stop) {
				return yield* new SandboxDriverRegistrationError({
					driver: driver.name,
					reason: "destroy capability requires stop capability",
				});
			}
			for (const operation of ["wake", "stop", "destroy"] as const) {
				if (driver.capabilities[operation] !== (driver[operation] !== undefined)) {
					return yield* new SandboxDriverRegistrationError({
						driver: driver.name,
						reason: `${operation} capability does not match its lifecycle implementation`,
					});
				}
			}
			entries.set(driver.name, erase(driver));
		}

		// `find` safely returns undefined if nothing
		// `get` throws
		const find = (name: Name) => Option.fromUndefinedOr(entries.get(name));
		const get = (name: Name) =>
			Effect.fromOption(find(name)).pipe(
				Effect.mapError(() => new SandboxDriverNotRegisteredError({ driver: name })),
			);

		const decodeCreateConfig = Effect.fn("SandboxDriver.Registry.decodeCreateConfig")(function* (
			name: Name,
			input: unknown,
		) {
			const driver = yield* get(name);
			return yield* Schema.decodeUnknownEffect(driver.createConfigCodec)(input).pipe(
				Effect.mapError((error) => codecFailure(name, error)),
			);
		});

		const decodeRuntimeConfig = Effect.fn("SandboxDriver.Registry.decodeRuntimeConfig")(function* (
			name: Name,
			input: unknown,
		) {
			const driver = yield* get(name);
			return yield* Schema.decodeUnknownEffect(driver.runtimeConfigCodec)(input).pipe(
				Effect.mapError((error) => codecFailure(name, error)),
			);
		});

		const encodeRuntimeConfig = Effect.fn("SandboxDriver.Registry.encodeRuntimeConfig")(function* (
			name: Name,
			input: RuntimeConfigBase,
		) {
			const driver = yield* get(name);
			return yield* Schema.encodeUnknownEffect(driver.runtimeConfigCodec)(input).pipe(
				Effect.mapError((error) => codecFailure(name, error)),
			);
		});

		return Registry.of({
			names: new Set(entries.keys()),
			find,
			get,
			decodeCreateConfig,
			decodeRuntimeConfig,
			encodeRuntimeConfig,
		});
	});

/**
 * Register a static set of drivers for one process-lifetime control plane.
 *
 * `driver()` preserves the concrete driver at its definition site; this layer
 * is the only erasure boundary.
 */
export const layer = (...drivers: ReadonlyArray<Registration>) => Layer.effect(Registry, makeRegistry(drivers));

export const driver = <CreateConfig, RuntimeConfig extends RuntimeConfigBase>(
	value: Driver<CreateConfig, RuntimeConfig>,
): Driver<CreateConfig, RuntimeConfig> & Registration =>
	Object.assign(value, {
		registered: erase(value),
	});

export * as SandboxDriver from "./driver";
