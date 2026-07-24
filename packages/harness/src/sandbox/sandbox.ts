import { Layer } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { posix as path } from "node:path";
import { SandboxEnv } from "./env";
import { SandboxFileSystem } from "./filesystem/filesystem";
import { Local } from "./filesystem/local";
import { HostExe } from "./hostexe";
import { EnvInMemory } from "./inmemory";
import { EnvBash } from "./justbashexe";
import { EnvSqldb } from "./sqldb";
import { EnvNodeJSDefault } from "./nodejs";
import type { Shell } from "./shell";

// re-export from sandbox
export { SandboxEnv } from "./env";
export { EnvInMemory } from "./inmemory";
export { EnvBash } from "./justbashexe";
export { HostExe } from "./hostexe";
export { EnvNodeJSDefault } from "./nodejs";
export { EnvSqldb } from "./sqldb";
export { Process } from "./utils/process";

// remote
export { EnvDaytona } from "./providers/daytona";
export { EnvVercel } from "./providers/vercel";

/**
 * What every sandbox provides, wherever it runs: a filesystem, a way to execute
 * commands, and the identity of the environment those act on. Consumers depend
 * on these three services and nothing else, so a local VFS-backed sandbox and a
 * remote provider are interchangeable.
 *
 * The identity is part of the contract because anything persisted about a
 * sandbox has to be scoped to it — paths repeat across environments.
 */
export type Provides = SandboxFileSystem.Service | Shell | SandboxEnv.EnvId;

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
export const services = <E, RIn>(backend: LocalBackend<E, RIn>, envId: string) =>
	Layer.provideMerge(Layer.mergeAll(Local.layer, HostExe.layer(), SandboxEnv.layer(envId)), backend);

/** Default sandbox: the real OS filesystem and processes, rooted at `cwd`. */
export const defaultLayer = (cwd: string) => services(EnvNodeJSDefault.layer({ cwd }), SandboxEnv.DEFAULT);

// Named constructors choose backend and identity together. Low-level assemblers
// require an explicit id because a custom backend's namespace cannot be inferred.

/** The host machine: real filesystem, real processes. Identity is always `local`. */
export const local = (cwd: string) => defaultLayer(cwd);

/**
 * An in-process VFS with just-bash over it — no host disk, no host processes.
 * Each call is a distinct namespace and says so, and none of them survive the
 * process.
 */
export const memory = () => EnvBash.services(EnvInMemory.layer(), SandboxEnv.mint("memory"));

/**
 * A sqlite-backed VFS with just-bash over it. With a `location` the file is the
 * state and the address reattaches; without one the database is in memory and
 * the identity is minted for distinctness only.
 */
export const sqldb = (options?: { readonly location?: string }) => {
	const location = options?.location === undefined ? undefined : path.resolve(options.location);
	return EnvBash.services(
		EnvSqldb.layer({ location }),
		location === undefined ? SandboxEnv.mint("sqldb") : SandboxEnv.format({ kind: "sqldb", instance: location }),
	);
};

export * as Sandbox from "./sandbox";
