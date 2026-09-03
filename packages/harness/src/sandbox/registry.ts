import { Context, Effect, type JsonSchema, Layer, Option, Schema } from "effect";
import { SandboxDriver } from "./driver.ts";
import { SandboxDriverNotRegisteredError, SandboxDriverRegistrationError } from "./errors.ts";

export interface DriverInfo {
	readonly name: SandboxDriver.Name;
	readonly kind: SandboxDriver.Registered["kind"];
	readonly apiVersion: SandboxDriver.ApiVersion;
	readonly source: SandboxDriver.Source;
	readonly capabilities: SandboxDriver.Capabilities;
	readonly createConfig: JsonSchema.JsonSchema;
}

export interface RegistryService {
	readonly names: ReadonlySet<SandboxDriver.Name>;
	readonly drivers: ReadonlyArray<DriverInfo>;
	readonly find: (name: SandboxDriver.Name) => Option.Option<SandboxDriver.Registered>;
	readonly get: (name: SandboxDriver.Name) => Effect.Effect<SandboxDriver.Registered, SandboxDriverNotRegisteredError>;
	readonly decodeCreateConfig: (
		name: SandboxDriver.Name,
		input: unknown,
	) => Effect.Effect<unknown, SandboxDriverNotRegisteredError | SandboxDriverRegistrationError>;
	readonly decodeRuntimeConfig: (
		name: SandboxDriver.Name,
		input: unknown,
	) => Effect.Effect<
		SandboxDriver.RuntimeConfigBase,
		SandboxDriverNotRegisteredError | SandboxDriverRegistrationError
	>;
	readonly encodeRuntimeConfig: (
		name: SandboxDriver.Name,
		input: SandboxDriver.RuntimeConfigBase,
	) => Effect.Effect<unknown, SandboxDriverNotRegisteredError | SandboxDriverRegistrationError>;
}

export class Registry extends Context.Service<Registry, RegistryService>()("@codeworksh/harness/sandbox/registry") {}

const codecFailure = (driver: SandboxDriver.Name, reason: unknown) =>
	new SandboxDriverRegistrationError({ driver, reason: String(reason) });

const reserved = new Set(["local", "memory", "sqldb", "vercel", "daytona"]);

export const make = (
	drivers: ReadonlyArray<SandboxDriver.Registration>,
): Effect.Effect<RegistryService, SandboxDriverRegistrationError> =>
	Effect.gen(function* () {
		const entries = new Map<SandboxDriver.Name, SandboxDriver.Registered>();
		const infos = new Map<SandboxDriver.Name, DriverInfo>();

		for (const registration of drivers) {
			const value = registration.registered;
			if (entries.has(value.name)) {
				return yield* new SandboxDriverRegistrationError({
					driver: value.name,
					reason: "duplicate driver registration",
				});
			}
			if (reserved.has(value.name) && registration.source !== "core" && registration.source !== "builtin") {
				return yield* new SandboxDriverRegistrationError({
					driver: value.name,
					reason: "reserved driver name cannot be registered by a third-party package",
				});
			}
			if (value.capabilities.destroy && !value.capabilities.stop) {
				return yield* new SandboxDriverRegistrationError({
					driver: value.name,
					reason: "destroy capability requires stop capability",
				});
			}
			for (const operation of ["inspect", "wake", "stop", "destroy"] as const) {
				if (value.capabilities[operation] !== (value[operation] !== undefined)) {
					return yield* new SandboxDriverRegistrationError({
						driver: value.name,
						reason: `${operation} capability does not match its lifecycle implementation`,
					});
				}
			}
			if (value.capabilities.reattach !== (value.runtimeConfigFor !== undefined)) {
				return yield* new SandboxDriverRegistrationError({
					driver: value.name,
					reason: "reattach capability does not match runtimeConfigFor implementation",
				});
			}

			const createConfig = yield* Effect.try({
				try: () => Schema.toJsonSchemaDocument(value.createConfigCodec).schema,
				catch: (reason) => codecFailure(value.name, reason),
			});
			const erased = SandboxDriver.erase(value);
			entries.set(value.name, erased);
			infos.set(value.name, {
				name: value.name,
				kind: value.kind,
				apiVersion: registration.apiVersion,
				source: registration.source,
				capabilities: { ...value.capabilities },
				createConfig,
			});
		}

		const find = (name: SandboxDriver.Name) => Option.fromUndefinedOr(entries.get(name));
		const get = (name: SandboxDriver.Name) =>
			Effect.fromOption(find(name)).pipe(
				Effect.mapError(
					() =>
						new SandboxDriverNotRegisteredError({
							driver: name,
							registered: [...entries.keys()].sort().slice(0, 5),
						}),
				),
			);

		const decodeCreateConfig = Effect.fn("SandboxDriver.Registry.decodeCreateConfig")(function* (
			name: SandboxDriver.Name,
			input: unknown,
		) {
			const value = yield* get(name);
			return yield* Schema.decodeUnknownEffect(value.createConfigCodec)(input).pipe(
				Effect.mapError((error) => codecFailure(name, error)),
			);
		});

		const decodeRuntimeConfig = Effect.fn("SandboxDriver.Registry.decodeRuntimeConfig")(function* (
			name: SandboxDriver.Name,
			input: unknown,
		) {
			const value = yield* get(name);
			return yield* Schema.decodeUnknownEffect(value.runtimeConfigCodec)(input).pipe(
				Effect.mapError((error) => codecFailure(name, error)),
			);
		});

		const encodeRuntimeConfig = Effect.fn("SandboxDriver.Registry.encodeRuntimeConfig")(function* (
			name: SandboxDriver.Name,
			input: SandboxDriver.RuntimeConfigBase,
		) {
			const value = yield* get(name);
			return yield* Schema.encodeUnknownEffect(value.runtimeConfigCodec)(input).pipe(
				Effect.mapError((error) => codecFailure(name, error)),
			);
		});

		return Registry.of({
			names: new Set(entries.keys()),
			drivers: [...infos.values()].sort((left, right) => left.name.localeCompare(right.name)),
			find,
			get,
			decodeCreateConfig,
			decodeRuntimeConfig,
			encodeRuntimeConfig,
		});
	});

export const layer = (...drivers: ReadonlyArray<SandboxDriver.Registration>) => Layer.effect(Registry, make(drivers));

export * as SandboxDriverRegistry from "./registry.ts";
