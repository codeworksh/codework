import { Cause, Context, DateTime, type Duration, Effect, Layer, LayerMap, Option, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { SandboxInstanceRow } from "../db/schema.sql.ts";
import { SandboxDriver } from "./driver.ts";
import {
	providerError,
	providerErrorIsNotFound,
	SandboxBusyError,
	type SandboxCreateError,
	type SandboxDestroyError,
	type SandboxDriverNotRegisteredError,
	SandboxDriverRegistrationError,
	type SandboxMountError,
	SandboxMustBeStoppedError,
	SandboxNotFoundError,
	SandboxProviderError,
	type SandboxReadError,
	type SandboxRefreshError,
	type SandboxRegisterError,
	SandboxRemovedError,
	type SandboxStopError,
	SandboxTransitionConflictError,
	SandboxUnavailError,
	SandboxUnsupportedError,
	type SandboxWakeError,
	sanitizeError,
} from "./errors.ts";
import { SandboxFileSystem } from "./fs/filesystem.ts";
import { EnvNodeJSDefault } from "./fs/nodejs.ts";
import { Local } from "./fs/vfs.ts";
import { SandboxInstance } from "./instance.ts";
import { SandboxIO } from "./io.ts";
import { HostExe } from "./shell/host.ts";
import { withCwd as shellWithCwd } from "./shell/shell.ts";
import { SandboxStore } from "./store.ts";

export interface CreateInput<CreateConfig, RuntimeConfig extends SandboxDriver.RuntimeConfigBase> {
	readonly driver: SandboxDriver.Definition<CreateConfig, RuntimeConfig>;
	readonly config: CreateConfig;
	readonly metadata?: Readonly<Record<string, string>> | undefined;
	/** Reserved for isolated test/script constructors that already own an id. */
	readonly instanceId?: SandboxInstance.ID | undefined;
}

export interface RegisterInput<CreateConfig, RuntimeConfig extends SandboxDriver.RuntimeConfigBase> {
	readonly driver: SandboxDriver.Definition<CreateConfig, RuntimeConfig>;
	readonly providerResourceId: string;
	readonly runtimeConfig?: Partial<RuntimeConfig> | undefined;
	readonly metadata?: Readonly<Record<string, string>> | undefined;
}

export interface MountOptions {
	/** Absolute, or relative to RuntimeConfig.defaultCwd. */
	readonly cwd?: string;
}

export interface DestroyOptions {
	/** Skip only this process's live-reference guard. */
	readonly force?: boolean;
}

export interface ListInput {
	readonly driver?: SandboxDriver.Name;
	readonly status?: SandboxInstance.Status;
	readonly usage?: SandboxInstance.Usage;
}

export interface Interface {
	readonly create: <CreateConfig, RuntimeConfig extends SandboxDriver.RuntimeConfigBase>(
		input: CreateInput<CreateConfig, RuntimeConfig>,
	) => Effect.Effect<SandboxInstance.Info, SandboxCreateError>;
	readonly createAndMount: <CreateConfig, RuntimeConfig extends SandboxDriver.RuntimeConfigBase>(
		input: CreateInput<CreateConfig, RuntimeConfig>,
		options?: MountOptions,
	) => SandboxIO.Layer<SandboxCreateError | SandboxMountError>;
	readonly register: <CreateConfig, RuntimeConfig extends SandboxDriver.RuntimeConfigBase>(
		input: RegisterInput<CreateConfig, RuntimeConfig>,
	) => Effect.Effect<SandboxInstance.Info, SandboxRegisterError>;
	readonly get: (id: SandboxInstance.ID) => Effect.Effect<Option.Option<SandboxInstance.Info>, SandboxReadError>;
	readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<SandboxInstance.Info>, SandboxReadError>;
	/** Resolve a session cwd without mounting or waking the sandbox. */
	readonly resolveCwd: (
		id?: SandboxInstance.ID,
		override?: string,
	) => Effect.Effect<SandboxDriver.AbsolutePath, SandboxMountError>;
	readonly refresh: (id: SandboxInstance.ID) => Effect.Effect<SandboxInstance.Info, SandboxRefreshError>;
	readonly mount: (id?: SandboxInstance.ID, options?: MountOptions) => SandboxIO.Layer<SandboxMountError>;
	readonly withMount: <A, E, R>(
		id: SandboxInstance.ID | undefined,
		use: Effect.Effect<A, E, R>,
		options?: MountOptions,
	) => Effect.Effect<A, E | SandboxMountError, Exclude<R, SandboxIO.Provides>>;
	readonly wake: (id: SandboxInstance.ID) => Effect.Effect<SandboxInstance.Info, SandboxWakeError>;
	readonly stop: (id: SandboxInstance.ID) => Effect.Effect<SandboxInstance.Info, SandboxStopError>;
	readonly destroy: (id: SandboxInstance.ID, options?: DestroyOptions) => Effect.Effect<void, SandboxDestroyError>;
}

export class Controller extends Context.Service<Controller, Interface>()(
	"@codeworksh/harness/sandbox/control/Controller",
) {}

export interface Options {
	readonly transportIdleTimeToLive?: Duration.Input;
	readonly provisioningTimeoutMs?: number;
}

const hostTransport = Layer.provide(Layer.merge(Local.layer, HostExe.layer()), EnvNodeJSDefault.layer());

const asDate = DateTime.toDateUtc;
const optionalDate = Option.map(DateTime.toDateUtc);
const MetadataJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const PersistedErrorJson = Schema.fromJsonString(SandboxInstance.PersistedError);
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeEffect(UnknownJson);
const encodeUnknownJson = Schema.encodeEffect(UnknownJson);
const encodeMetadataJson = Schema.encodeEffect(MetadataJson);
const encodePersistedErrorJson = Schema.encodeEffect(PersistedErrorJson);

/** Schema-aware runtime check; `instanceof` does not survive schema decoding. */
const isSandboxProviderError = Schema.is(SandboxProviderError);

const parseJson = (driver: SandboxDriver.Name, operation: string, value: string) =>
	decodeUnknownJson(value).pipe(Effect.mapError((cause) => providerError({ driver, operation, cause })));

export const make = Effect.fn("Sandbox.Controller.make")(function* (options: Options = {}) {
	const sql = yield* SqlClient.SqlClient;
	const registry = yield* SandboxDriver.Registry;
	const store = yield* SandboxStore.make;
	const gate = yield* Semaphore.make(1);
	const refs = new Map<SandboxInstance.ID, number>();
	const hostDefaultCwd = process.cwd();
	const hostCreatedAt = asDate(yield* DateTime.now);

	const refCount = (id: SandboxInstance.ID) => refs.get(id) ?? 0;
	const usage = (id: SandboxInstance.ID, count = refCount(id)): SandboxInstance.Usage =>
		id === SandboxInstance.ID.local ? "pinned" : count > 0 ? "busy" : "idle";
	interface Lease {
		held: boolean;
		mounted: boolean;
	}

	const acquireLease = (id: SandboxInstance.ID, lease: Lease) =>
		gate.withPermits(1)(
			Effect.sync(() => {
				const wasIdle = refCount(id) === 0;
				refs.set(id, refCount(id) + 1);
				lease.held = true;
				return wasIdle;
			}),
		);

	const releaseLease = (id: SandboxInstance.ID, lease: Lease) =>
		Effect.gen(function* () {
			if (!lease.held) return;
			yield* gate.withPermits(1)(
				Effect.sync(() => {
					const next = Math.max(0, refCount(id) - 1);
					if (next === 0) refs.delete(id);
					else refs.set(id, next);
					lease.held = false;
				}),
			);
			if (!lease.mounted) return;
			const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
			yield* sql`
				UPDATE sandbox_instance
				SET last_unmounted_at = ${now}, last_used_at = ${now}, updated_at = ${now}
				WHERE id = ${id}
			`.pipe(Effect.orDie);
		});

	const toInfo = (row: SandboxInstanceRow): SandboxInstance.Info => {
		const count = refCount(row.id);
		return {
			id: row.id,
			driver: SandboxDriver.Name.make(row.driver),
			kind: row.kind,
			providerResourceId: row.providerResourceId,
			ownership: row.ownership,
			status: row.status,
			usage: usage(row.id, count),
			refCount: count,
			providerStatus: row.providerStatus,
			metadata: Option.getOrElse(row.metadata, () => ({})),
			lastError: row.lastError,
			createdAt: asDate(row.createdAt),
			updatedAt: asDate(row.updatedAt),
			stateObservedAt: asDate(row.stateObservedAt),
			lastMountedAt: optionalDate(row.lastMountedAt),
			lastUnmountedAt: optionalDate(row.lastUnmountedAt),
			lastUsedAt: optionalDate(row.lastUsedAt),
			removedAt: optionalDate(row.removedAt),
		};
	};

	const hostInfo = (): SandboxInstance.Info => ({
		id: SandboxInstance.ID.local,
		driver: SandboxDriver.Name.make("local"),
		kind: "local",
		providerResourceId: Option.none(),
		ownership: "external",
		status: "online",
		usage: "pinned",
		refCount: 0,
		providerStatus: Option.none(),
		metadata: {},
		lastError: Option.none(),
		createdAt: hostCreatedAt,
		updatedAt: hostCreatedAt,
		stateObservedAt: hostCreatedAt,
		lastMountedAt: Option.none(),
		lastUnmountedAt: Option.none(),
		lastUsedAt: Option.none(),
		removedAt: Option.none(),
	});

	const findRow = (id: SandboxInstance.ID) => store.find(id);
	const requireRow = Effect.fn("Sandbox.Controller.requireRow")(function* (id: SandboxInstance.ID) {
		const found = yield* findRow(id);
		if (Option.isNone(found)) return yield* new SandboxNotFoundError({ id });
		return found.value;
	});

	const reload = Effect.fn("Sandbox.Controller.reload")(function* (id: SandboxInstance.ID) {
		return toInfo(yield* requireRow(id));
	});

	const runtime = Effect.fn("Sandbox.Controller.runtime")(function* (row: SandboxInstanceRow, operation: string) {
		const driverName = SandboxDriver.Name.make(row.driver);
		const driver = yield* registry.get(driverName);
		if (driver.kind !== row.kind) {
			return yield* providerError({
				driver: driverName,
				operation,
				cause: new Error(`registered kind ${driver.kind} conflicts with persisted kind ${row.kind}`),
			});
		}
		if (Option.isNone(row.runtimeConfig)) {
			return yield* providerError({
				driver: driverName,
				operation,
				cause: new Error(`sandbox runtime config is missing: ${row.id}`),
			});
		}
		const decoded = yield* parseJson(driverName, operation, row.runtimeConfig.value);
		const runtimeConfig = yield* registry
			.decodeRuntimeConfig(driverName, decoded)
			.pipe(Effect.mapError((cause) => providerError({ driver: driverName, operation, cause })));
		return {
			driver,
			input: {
				id: row.id,
				providerResourceId: row.providerResourceId,
				runtimeConfig,
			},
		};
	});

	const updateObservation = Effect.fn("Sandbox.Controller.updateObservation")(function* (input: {
		readonly id: SandboxInstance.ID;
		readonly status: SandboxInstance.Status;
		readonly providerStatus?: string | undefined;
		readonly metadata?: Readonly<Record<string, string>> | undefined;
		readonly lastError?: SandboxInstance.PersistedError | undefined;
		readonly clearError?: boolean | undefined;
	}) {
		const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
		const metadata =
			input.metadata === undefined ? null : yield* encodeMetadataJson(input.metadata).pipe(Effect.orDie);
		const lastError =
			input.clearError === true
				? null
				: input.lastError === undefined
					? undefined
					: yield* encodePersistedErrorJson(input.lastError).pipe(Effect.orDie);
		yield* sql`
			UPDATE sandbox_instance
			SET
				status = ${input.status},
				provider_status = ${input.providerStatus ?? null},
				state_observed_at = ${now},
				metadata = COALESCE(${metadata}, metadata),
				last_error = CASE
					WHEN ${input.clearError === true ? 1 : 0} = 1 THEN NULL
					WHEN ${lastError ?? null} IS NOT NULL THEN ${lastError ?? null}
					ELSE last_error
				END,
				updated_at = ${now}
			WHERE id = ${input.id}
		`.pipe(Effect.orDie);
	});

	const markUnavailable = Effect.fn("Sandbox.Controller.markUnavailable")(function* (
		id: SandboxInstance.ID,
		error: SandboxProviderError,
	) {
		yield* updateObservation({
			id,
			status: "unavail",
			lastError: error.sanitized,
		});
		return yield* new SandboxUnavailError({ id, reason: error.sanitized.message });
	});

	const persistProviderFailure = Effect.fn("Sandbox.Controller.persistProviderFailure")(function* (
		id: SandboxInstance.ID,
		status: SandboxInstance.Status,
		error: SandboxProviderError,
	) {
		yield* updateObservation({ id, status, lastError: error.sanitized });
		return yield* error;
	});

	type TransportError = SandboxNotFoundError | SandboxDriverNotRegisteredError | SandboxProviderError;

	const transportLayer = (
		id: SandboxInstance.ID,
	): Layer.Layer<SandboxIO.FileSystem | SandboxIO.Shell, TransportError> =>
		id === SandboxInstance.ID.local
			? hostTransport
			: Layer.unwrap(
					Effect.gen(function* () {
						const row = yield* requireRow(id);
						const attached = yield* runtime(row, "attach");
						return attached.driver.attach(attached.input);
					}),
				);

	const transports = yield* LayerMap.make(transportLayer, {
		idleTimeToLive: options.transportIdleTimeToLive ?? "30 seconds",
	});

	// A registry configured with the wrong kind cannot safely interpret existing
	// rows. Fail the process layer before any lifecycle operation runs.
	for (const row of yield* store.list) {
		const registered = registry.find(SandboxDriver.Name.make(row.driver));
		if (Option.isSome(registered) && registered.value.kind !== row.kind) {
			return yield* new SandboxDriverRegistrationError({
				driver: registered.value.name,
				reason: `registered kind ${registered.value.kind} conflicts with persisted kind ${row.kind}`,
			});
		}
	}

	const startupNow = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
	const provisioningCutoff = startupNow - (options.provisioningTimeoutMs ?? 300_000);
	const creationInterrupted = yield* encodePersistedErrorJson({
		name: "SandboxCreationInterrupted",
		message: "sandbox creation was interrupted before provisioning completed",
	}).pipe(Effect.orDie);
	yield* sql`
			UPDATE sandbox_instance
			SET
				status = 'faulted',
				last_error = ${creationInterrupted},
			updated_at = ${startupNow}
		WHERE status = 'provisioning' AND state_observed_at < ${provisioningCutoff}
	`.pipe(Effect.orDie);

	const get: Interface["get"] = (id) =>
		id === SandboxInstance.ID.local
			? Effect.succeed(Option.some(hostInfo()))
			: Effect.map(findRow(id), Option.map(toInfo));

	const list: Interface["list"] = (input = {}) =>
		Effect.map(store.list, (rows) =>
			[hostInfo(), ...rows.map(toInfo)].filter(
				(info) =>
					(input.driver === undefined || info.driver === input.driver) &&
					(input.status === undefined || info.status === input.status) &&
					(input.usage === undefined || info.usage === input.usage),
			),
		);

	const resolveCwd: Interface["resolveCwd"] = Effect.fn("Sandbox.Controller.resolveCwd")(function* (
		id = SandboxInstance.ID.local,
		override,
	) {
		if (id === SandboxInstance.ID.local) {
			return SandboxDriver.AbsolutePath.make(SandboxIO.resolveMountCwd(hostDefaultCwd, override));
		}
		const row = yield* requireRow(id);
		if (row.status === "removed") {
			return yield* new SandboxRemovedError({ id, removedAt: Option.getOrUndefined(row.removedAt) });
		}
		if (row.status === "unavail") {
			return yield* new SandboxUnavailError({ id, reason: "driver resource is unavailable" });
		}
		const attached = yield* runtime(row, "resolveCwd");
		return SandboxDriver.AbsolutePath.make(
			SandboxIO.resolveMountCwd(attached.input.runtimeConfig.defaultCwd, override),
		);
	});

	const create: Interface["create"] = Effect.fn("Sandbox.Controller.create")(function* (input) {
		const driver = yield* registry.get(input.driver.name);
		const config = yield* registry.decodeCreateConfig(input.driver.name, input.config);
		const id = input.instanceId ?? SandboxInstance.ID.create();
		if (id === SandboxInstance.ID.local || Option.isSome(yield* store.find(id))) {
			return yield* new SandboxDriverRegistrationError({
				driver: driver.name,
				reason: `sandbox instance id is already registered or reserved: ${id}`,
			});
		}
		yield* store.register({
			id,
			driver: driver.name,
			kind: driver.kind,
			ownership: "managed",
			status: "provisioning",
			metadata: input.metadata,
		});

		const provisioned = yield* driver
			.create({ instanceId: id, config })
			.pipe(Effect.catch((error) => persistProviderFailure(id, "faulted", error)));
		const finalize = Effect.gen(function* () {
			const encoded = yield* registry.encodeRuntimeConfig(driver.name, provisioned.runtimeConfig);
			const runtimeConfig = yield* encodeUnknownJson(encoded).pipe(
				Effect.mapError((cause) => providerError({ driver: driver.name, operation: "create", cause })),
			);
			const metadata = { ...input.metadata, ...provisioned.metadata };
			const persistedMetadata =
				Object.keys(metadata).length === 0 ? null : yield* encodeMetadataJson(metadata).pipe(Effect.orDie);
			const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
			yield* sql`
				UPDATE sandbox_instance
				SET
					provider_resource_id = ${provisioned.providerResourceId ?? null},
					runtime_config = ${runtimeConfig},
					status = 'online',
					provider_status = ${provisioned.providerStatus ?? null},
					state_observed_at = ${now},
					metadata = ${persistedMetadata},
					last_error = NULL,
					updated_at = ${now}
				WHERE id = ${id} AND status = 'provisioning'
			`.pipe(Effect.orDie);
			return yield* reload(id).pipe(Effect.orDie);
		});

		return yield* finalize.pipe(
			Effect.catchCause((cause) => {
				const compensate =
					driver.destroy === undefined
						? Effect.void
						: driver
								.destroy({
									id,
									providerResourceId: Option.fromUndefinedOr(provisioned.providerResourceId),
									runtimeConfig: provisioned.runtimeConfig,
								})
								.pipe(
									Effect.catch((error) =>
										Effect.logError("Failed to compensate sandbox creation", error).pipe(
											Effect.annotateLogs({ sandboxInstanceId: id, driver: driver.name }),
										),
									),
								);
				return compensate.pipe(
					Effect.andThen(
						updateObservation({
							id,
							status: "faulted",
							lastError: sanitizeError(Cause.squash(cause)),
						}),
					),
					Effect.andThen(Effect.failCause(cause)),
				);
			}),
		);
	});

	const register: Interface["register"] = Effect.fn("Sandbox.Controller.register")(function* (input) {
		const driver = yield* registry.get(input.driver.name);
		const existing = (yield* store.list).find(
			(row) =>
				row.driver === driver.name &&
				Option.getOrUndefined(row.providerResourceId) === input.providerResourceId &&
				row.status !== "removed",
		);
		const runtimeConfig = yield* driver.runtimeConfigFor({
			providerResourceId: input.providerResourceId,
			overrides: input.runtimeConfig as Readonly<Record<string, unknown>> | undefined,
		});
		const encoded = yield* registry.encodeRuntimeConfig(driver.name, runtimeConfig);
		const persisted = yield* encodeUnknownJson(encoded).pipe(
			Effect.mapError((cause) => providerError({ driver: driver.name, operation: "register", cause })),
		);

		if (existing !== undefined) {
			if (existing.ownership !== "external" || existing.kind !== driver.kind) {
				return yield* new SandboxDriverRegistrationError({
					driver: driver.name,
					reason: `resource is already registered with incompatible identity: ${input.providerResourceId}`,
				});
			}
			if (Option.isSome(existing.runtimeConfig) && existing.runtimeConfig.value !== persisted) {
				return yield* new SandboxDriverRegistrationError({
					driver: driver.name,
					reason: `resource is already registered with different runtime config: ${input.providerResourceId}`,
				});
			}
			return toInfo(existing);
		}

		const id = SandboxInstance.ID.create();
		yield* store.register({
			id,
			driver: driver.name,
			kind: driver.kind,
			ownership: "external",
			status: "online",
			providerResourceId: input.providerResourceId,
			runtimeConfig: persisted,
			metadata: input.metadata,
		});
		return yield* reload(id).pipe(Effect.orDie);
	});

	const mountLayer = (id = SandboxInstance.ID.local, mountOptions: MountOptions = {}, reserved?: Lease) =>
		Layer.unwrap(
			Effect.gen(function* () {
				let identity: SandboxIO.Identity;
				let invalidateBeforeAttach = false;
				const lease: Lease = reserved ?? { held: false, mounted: false };

				if (id === SandboxInstance.ID.local) {
					identity = {
						id,
						driver: SandboxDriver.Name.make("local"),
						kind: "local",
						cwd: SandboxIO.resolveMountCwd(hostDefaultCwd, mountOptions.cwd),
					};
				} else {
					const row = yield* requireRow(id);
					if (row.status === "removed") {
						return yield* new SandboxRemovedError({
							id,
							removedAt: Option.getOrUndefined(row.removedAt),
						});
					}
					if (row.status === "unavail") {
						return yield* new SandboxUnavailError({ id, reason: "driver resource is unavailable" });
					}
					if (!SandboxInstance.isMountable(row.status)) {
						return yield* new SandboxUnavailError({
							id,
							reason: `sandbox is not mountable while ${row.status}`,
						});
					}
					invalidateBeforeAttach = row.status !== "online";
					const attached = yield* runtime(row, "mount");
					identity = {
						id,
						driver: attached.driver.name,
						kind: row.kind,
						cwd: SandboxIO.resolveMountCwd(attached.input.runtimeConfig.defaultCwd, mountOptions.cwd),
					};

					const wasIdle = lease.held
						? false
						: yield* gate.withPermits(1)(
								Effect.gen(function* () {
									const latest = yield* requireRow(id);
									if (latest.status === "removed") {
										return yield* new SandboxRemovedError({
											id,
											removedAt: Option.getOrUndefined(latest.removedAt),
										});
									}
									if (latest.status === "unavail" || !SandboxInstance.isMountable(latest.status)) {
										return yield* new SandboxUnavailError({
											id,
											reason: `sandbox is not mountable while ${latest.status}`,
										});
									}
									const idle = refCount(id) === 0;
									refs.set(id, refCount(id) + 1);
									lease.held = true;
									return idle;
								}),
							);
					if (reserved === undefined) yield* Effect.addFinalizer(() => releaseLease(id, lease));

					if (wasIdle && invalidateBeforeAttach) yield* transports.invalidate(id);
				}

				const handleTransportError = (error: TransportError): Effect.Effect<never, SandboxMountError> => {
					if (isSandboxProviderError(error) && providerErrorIsNotFound(error)) {
						return markUnavailable(id, error);
					}
					if (isSandboxProviderError(error)) return persistProviderFailure(id, "faulted", error);
					return Effect.fail(error);
				};

				const context = yield* transports.contextEffect(id).pipe(
					Effect.catch((error) => {
						if (isSandboxProviderError(error) && providerErrorIsNotFound(error)) {
							return markUnavailable(id, error);
						}
						if (isSandboxProviderError(error)) {
							// A persisted `online` status can outlive a provider session
							// URL. Drop the failed entry and attach once more before
							// recording a fault; never create a replacement namespace.
							return transports
								.invalidate(id)
								.pipe(Effect.andThen(transports.contextEffect(id)), Effect.catch(handleTransportError));
						}
						return Effect.fail(error);
					}),
				);
				const fs = Context.get(context, SandboxIO.FileSystem);
				const shell = Context.get(context, SandboxIO.Shell);
				lease.mounted = true;

				if (id !== SandboxInstance.ID.local) {
					const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
					yield* sql`
						UPDATE sandbox_instance
						SET
							status = 'online',
							last_error = NULL,
							last_mounted_at = ${now},
							last_used_at = ${now},
							state_observed_at = ${now},
							updated_at = ${now}
						WHERE id = ${id}
					`.pipe(Effect.orDie);
				}

				return Layer.mergeAll(
					Layer.succeed(SandboxIO.Current, identity),
					Layer.succeed(SandboxIO.FileSystem, SandboxFileSystem.withCwd(fs, identity.cwd)),
					Layer.succeed(SandboxIO.Shell, shellWithCwd(shell, identity.cwd)),
				);
			}),
		);

	const mount: Interface["mount"] = (id, mountOptions) => mountLayer(id, mountOptions);

	const withMount: Interface["withMount"] = (id, use, mountOptions) =>
		use.pipe(Effect.provide(mount(id, mountOptions)), Effect.scoped);

	const refresh: Interface["refresh"] = Effect.fn("Sandbox.Controller.refresh")(function* (id) {
		if (id === SandboxInstance.ID.local) {
			return yield* new SandboxUnsupportedError({
				id,
				driver: "local",
				operation: "refresh",
			});
		}
		const row = yield* requireRow(id);
		const attached = yield* runtime(row, "inspect");
		if (attached.driver.inspect === undefined) {
			return yield* new SandboxUnsupportedError({
				id,
				driver: attached.driver.name,
				operation: "refresh",
			});
		}
		const observed = yield* attached.driver
			.inspect(attached.input)
			.pipe(
				Effect.catch(
					(error): Effect.Effect<never, SandboxProviderError | SandboxUnavailError> =>
						providerErrorIsNotFound(error)
							? markUnavailable(id, error)
							: persistProviderFailure(id, "faulted", error),
				),
			);
		yield* updateObservation({
			id,
			status: observed.status,
			providerStatus: observed.providerStatus,
			metadata: observed.metadata,
			clearError: true,
		});
		return yield* reload(id);
	});

	const wake: Interface["wake"] = Effect.fn("Sandbox.Controller.wake")(function* (id) {
		if (id === SandboxInstance.ID.local) return hostInfo();
		const row = yield* requireRow(id);
		if (row.status === "removed") {
			return yield* new SandboxRemovedError({
				id,
				removedAt: Option.getOrUndefined(row.removedAt),
			});
		}
		const attached = yield* runtime(row, "wake");
		if (!attached.driver.capabilities.wake || attached.driver.wake === undefined) {
			return yield* new SandboxUnsupportedError({
				id,
				driver: attached.driver.name,
				operation: "wake",
			});
		}
		if (refCount(id) === 0) yield* transports.invalidate(id);
		const observed = yield* attached.driver
			.wake(attached.input)
			.pipe(
				Effect.catch(
					(error): Effect.Effect<never, SandboxProviderError | SandboxUnavailError> =>
						providerErrorIsNotFound(error)
							? markUnavailable(id, error)
							: persistProviderFailure(id, "faulted", error),
				),
			);
		yield* updateObservation({
			id,
			status: observed.status,
			providerStatus: observed.providerStatus,
			metadata: observed.metadata,
			clearError: true,
		});
		return yield* reload(id);
	});

	const stop: Interface["stop"] = Effect.fn("Sandbox.Controller.stop")(function* (id) {
		if (id === SandboxInstance.ID.local) {
			return yield* new SandboxUnsupportedError({ id, driver: "local", operation: "stop" });
		}
		const row = yield* requireRow(id);
		const driverName = SandboxDriver.Name.make(row.driver);
		const driver = yield* registry.get(driverName);
		if (!driver.capabilities.stop || driver.stop === undefined || row.ownership !== "managed") {
			return yield* new SandboxUnsupportedError({ id, driver: driverName, operation: "stop" });
		}
		const claim = yield* gate.withPermits(1)(
			Effect.gen(function* () {
				const latest = yield* requireRow(id);
				const count = refCount(id);
				if (count > 0) return yield* new SandboxBusyError({ id, refCount: count });
				if (latest.status === "offline") return { claimed: false as const, row: latest };
				if (latest.status === "removed") {
					return yield* new SandboxRemovedError({
						id,
						removedAt: Option.getOrUndefined(latest.removedAt),
					});
				}
				const moved = yield* store.transition({
					id,
					from: ["online", "faulted", "unavail"],
					to: "suspending",
				});
				if (!moved) {
					const actual = yield* requireRow(id);
					return yield* new SandboxTransitionConflictError({
						id,
						expected: ["online", "faulted", "unavail"],
						actual: actual.status,
					});
				}
				return { claimed: true as const };
			}),
		);
		if (!claim.claimed) return toInfo(claim.row);
		yield* transports.invalidate(id);
		const current = yield* requireRow(id);
		const attached = yield* runtime(current, "stop");
		const observed = yield* attached.driver.stop!(attached.input).pipe(
			Effect.catch(
				(error): Effect.Effect<never, SandboxProviderError | SandboxUnavailError> =>
					providerErrorIsNotFound(error)
						? markUnavailable(id, error)
						: persistProviderFailure(id, "faulted", error),
			),
		);
		yield* updateObservation({
			id,
			status: "offline",
			providerStatus: observed.providerStatus,
			metadata: observed.metadata,
			clearError: true,
		});
		return yield* reload(id);
	});

	const destroy: Interface["destroy"] = Effect.fn("Sandbox.Controller.destroy")(function* (id, destroyOptions = {}) {
		if (id === SandboxInstance.ID.local) {
			return yield* new SandboxUnsupportedError({ id, driver: "local", operation: "destroy" });
		}
		const row = yield* requireRow(id);
		const driverName = SandboxDriver.Name.make(row.driver);
		const driver = yield* registry.get(driverName);
		if (!driver.capabilities.destroy || driver.destroy === undefined || row.ownership !== "managed") {
			return yield* new SandboxUnsupportedError({ id, driver: driverName, operation: "destroy" });
		}
		const claim = yield* gate.withPermits(1)(
			Effect.gen(function* () {
				const latest = yield* requireRow(id);
				if (latest.status === "removed") return { claimed: false as const, refCount: 0 };
				const count = refCount(id);
				if (count > 0 && destroyOptions.force !== true) {
					return yield* new SandboxBusyError({ id, refCount: count });
				}
				if (latest.status !== "offline" && latest.status !== "unavail") {
					return yield* new SandboxMustBeStoppedError({ id, status: latest.status });
				}
				const moved = yield* store.transition({ id, from: ["offline", "unavail"], to: "removing" });
				if (!moved) {
					const actual = yield* requireRow(id);
					return yield* new SandboxTransitionConflictError({
						id,
						expected: ["offline", "unavail"],
						actual: actual.status,
					});
				}
				return { claimed: true as const, refCount: count, restoreStatus: latest.status };
			}),
		);
		if (!claim.claimed) return yield* Effect.void;
		if (claim.refCount > 0) {
			yield* Effect.logWarning("Force destroying a mounted sandbox").pipe(
				Effect.annotateLogs({ sandboxInstanceId: id, refCount: claim.refCount }),
			);
		}
		yield* transports.invalidate(id);
		const current = yield* requireRow(id);
		const attached = yield* runtime(current, "destroy");
		yield* attached.driver.destroy!(attached.input).pipe(
			Effect.catch((error) =>
				providerErrorIsNotFound(error) ? Effect.void : persistProviderFailure(id, claim.restoreStatus, error),
			),
		);
		const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
		yield* sql`
			UPDATE sandbox_instance
			SET
				status = 'removed',
				removed_at = ${now},
				state_observed_at = ${now},
				last_error = NULL,
				updated_at = ${now}
			WHERE id = ${id}
		`.pipe(Effect.orDie);
	});

	const createAndMount: Interface["createAndMount"] = (input, mountOptions) => {
		const id = input.instanceId ?? SandboxInstance.ID.create();
		const lease: Lease = { held: false, mounted: false };
		return Layer.unwrap(
			Effect.gen(function* () {
				// Reserve before the provider call. Once create inserts the
				// provisioning row, no observer can ever see it as idle.
				yield* acquireLease(id, lease);
				yield* Effect.addFinalizer(() => releaseLease(id, lease));
				yield* create({ ...input, instanceId: id });
				return mountLayer(id, mountOptions, lease);
			}),
		);
	};

	return Controller.of({
		create,
		createAndMount,
		register,
		get,
		list,
		resolveCwd,
		refresh,
		mount,
		withMount,
		wake,
		stop,
		destroy,
	});
});

export const layer = (options?: Options) => Layer.effect(Controller, make(options));

export * as SandboxController from "./control.ts";
