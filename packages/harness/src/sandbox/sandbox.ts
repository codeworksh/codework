import { Effect, Layer } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { Database } from "../db/db.ts";
import { posix as path } from "../util/posix.ts";
import { SandboxController } from "./control.ts";
import { SandboxDriver } from "./driver.ts";
import { MemorySandboxDriver } from "./drivers/memory.ts";
import { SqldbSandboxDriver } from "./drivers/sqldb.ts";
import { EnvNodeJSDefault } from "./fs/nodejs.ts";
import { Local } from "./fs/vfs.ts";
import { SandboxInstance } from "./instance.ts";
import { SandboxIO } from "./io.ts";
import { HostExe } from "./shell/host.ts";

// re-export from sandbox
export { SandboxController } from "./control.ts";
export { SandboxDriver } from "./driver.ts";
export { DaytonaSandboxDriver } from "./drivers/daytona.ts";
export { MemorySandboxDriver } from "./drivers/memory.ts";
export { SqldbSandboxDriver } from "./drivers/sqldb.ts";
export { VercelSandboxDriver } from "./drivers/vercel.ts";
export { SandboxError } from "./errors.ts";
export { EnvInMemory } from "./fs/inmemory.ts";
export { EnvNodeJSDefault } from "./fs/nodejs.ts";
export { EnvSqldb } from "./fs/sqldb.ts";
export { SandboxInstance } from "./instance.ts";
export { SandboxIO } from "./io.ts";
export { SandboxResource } from "./resource.ts";
export { HostExe } from "./shell/host.ts";
export { EnvBash } from "./shell/justbash.ts";
export { Process } from "./utils/process.ts";

/**
 * What every sandbox provides, wherever it runs: a filesystem, a way to execute
 * commands, and the identity of the instance those act on. Consumers depend on
 * these three services and nothing else, so a local VFS-backed sandbox and a
 * remote provider are interchangeable.
 *
 * The identity is part of the contract because anything persisted about a
 * sandbox has to be scoped to it — paths repeat across namespaces, so
 * `/workspace` alone never names a place.
 */
export type Provides = SandboxIO.Provides;

/** A sandbox is any Layer providing the runtime services above. */
export type Sandbox<E = never, RIn = never> = Layer.Layer<Provides, E, RIn>;

/**
 * The OS primitives a local backend supplies — a VFS to build the filesystem on
 * and a process spawner to build the shell on. This is local construction
 * detail, not part of the sandbox contract: remote providers implement
 * {@link Provides} directly and never produce these.
 */
export type LocalPrimitives = Local.Vfs | ChildProcessSpawner.ChildProcessSpawner;

/** A local backend: the raw primitives, before they are assembled into a sandbox. */
export type LocalBackend<E = never, RIn = never> = Layer.Layer<LocalPrimitives, E, RIn>;

/**
 * Assemble a local backend into a sandbox with a **real host shell** — the
 * right choice whenever commands must invoke actual binaries (`git`, package
 * managers). For a sandbox whose shell should stay inside the VFS, use
 * `EnvBash.services` instead, which wires just-bash over the same tree.
 */
export const services = <E, RIn>(backend: LocalBackend<E, RIn>, identity: SandboxIO.Identity) =>
	Layer.provideMerge(
		SandboxIO.mount(identity),
		Layer.provideMerge(Layer.merge(Local.layer, HostExe.layer()), backend),
	);

const controllerLayer = (...drivers: ReadonlyArray<SandboxDriver.Registration>) => {
	const dependencies = Layer.merge(Database.layer(":memory:"), SandboxDriver.layer(...drivers));
	return Layer.provide(SandboxController.layer(), dependencies);
};

/** Default sandbox: the real OS filesystem and processes, mounted at `cwd`. */
export const defaultLayer = (cwd?: string) => services(EnvNodeJSDefault.layer(), SandboxIO.host(cwd));

// Named constructors choose backend and identity together. Low-level assemblers
// require an explicit id because a custom backend's namespace cannot be inferred.

/**
 * The host machine: real filesystem, real processes. Identity is always `local`;
 * cwd defaults to the host process directory, matching Flue's local adapter.
 */
export const local = (cwd?: string) => defaultLayer(cwd);

/**
 * An in-process VFS with just-bash over it — no host disk, no host processes.
 * Each call is a distinct namespace and says so, and none of them survive the
 * process.
 */
export const memory = (options?: { readonly instanceId?: SandboxInstance.ID; readonly cwd?: string }) => {
	const memory = MemorySandboxDriver.make();
	const mountCwd = SandboxIO.resolveMountCwd("/", options?.cwd);
	return Layer.unwrap(
		Effect.map(SandboxController.Controller, (controller) =>
			controller.createAndMount(
				{
					driver: memory.driver,
					config: {
						defaultCwd: SandboxDriver.AbsolutePath.make("/"),
						initializeCwd: SandboxDriver.AbsolutePath.make(mountCwd),
					},
					instanceId: options?.instanceId,
				},
				{ cwd: mountCwd },
			),
		),
	).pipe(Layer.provide(controllerLayer(memory.driver)), Layer.orDie);
};

/**
 * A sqlite-backed VFS with just-bash over it. With a `location` the file is the
 * state and survives the process; without one the database is in memory and
 * dies with it. Either way the identity is minted unless the caller names one —
 * a backing file can be re-opened, but only its registrar knows under which ID.
 */
export const sqldb = (options?: {
	readonly location?: string;
	readonly instanceId?: SandboxInstance.ID;
	readonly cwd?: string;
}) => {
	const location = options?.location === undefined ? undefined : path.resolve(options.location);
	const sqldb = SqldbSandboxDriver.make();
	const mountCwd = SandboxIO.resolveMountCwd("/", options?.cwd);
	return Layer.unwrap(
		Effect.map(SandboxController.Controller, (controller) =>
			controller.createAndMount(
				{
					driver: sqldb.driver,
					config: {
						defaultCwd: SandboxDriver.AbsolutePath.make("/"),
						initializeCwd: SandboxDriver.AbsolutePath.make(mountCwd),
						...(location === undefined ? {} : { location }),
					},
					instanceId: options?.instanceId,
				},
				{ cwd: mountCwd },
			),
		),
	).pipe(Layer.provide(controllerLayer(sqldb.driver)), Layer.orDie);
};

export * as Sandbox from "./sandbox.ts";
