import { Layer } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { FileSystem } from "../filesystem/filesystem";
import { EnvDefault } from "./default";

// re-export from sandbox
export { EnvBash } from "./bash";
export { EnvDefault } from "./default";
export { EnvInMemory } from "./inmemory";
export { Process } from "./process";
export { EnvSqldb } from "./sqldb";

/**
 * The OS-primitive capabilities every sandbox must provide: the filesystem
 * backend and process execution. Networking, logging, etc. join this union
 * as they become sandboxed.
 */
export type Provides = FileSystem.Vfs | ChildProcessSpawner.ChildProcessSpawner;

/**
 * A sandbox is any Layer providing the OS primitives — this type is the
 * entire plugin contract. Swap implementations (envDefault, envInmemory,
 * envRemote, ...) at the composition root and the application is unchanged.
 */
export type Sandbox<E = never, RIn = never> = Layer.Layer<Provides, E, RIn>;

/**
 * App-facing services backed by the given sandbox: the FileSystem service
 * plus the sandbox's own capabilities (process spawner, ...). For
 * bash-wrapped sandboxes use `EnvBash.services`, which keeps the Shell type.
 */
export const services = <E, RIn>(sandbox: Sandbox<E, RIn>) => Layer.provideMerge(FileSystem.layer, sandbox);

/** Default sandbox: the real OS filesystem and processes rooted at `rootPath`. */
export const defaultLayer = (rootPath: string) => services(EnvDefault.layer(rootPath));

export * as Sandbox from "./sandbox";
