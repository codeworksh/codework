import { Layer } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { EnvDefault } from "./default";
import { Virtual } from "./filesystem/virtual";

// re-export from sandbox
export { EnvDefault } from "./default";
export { EnvInMemory } from "./inmemory";
export { EnvBash } from "./justbashexe";
export { EnvSqldb } from "./sqldb";
export { Process } from "./utils/process";

export { EnvDaytona } from "./providers/daytona";

/**
 * Local OS-primitive capabilities: a VFS-backed filesystem plus process
 * execution. Remote providers can skip this layer and provide runtime
 * services such as `SandboxFileSystem.Service` and `Shell` directly.
 */
export type Provides = Virtual.Vfs | ChildProcessSpawner.ChildProcessSpawner;

/**
 * A local sandbox is any Layer providing the local OS primitives. Remote
 * providers should expose their own service layer instead of adapting through
 * VFS.
 */
export type Sandbox<E = never, RIn = never> = Layer.Layer<Provides, E, RIn>;

/**
 * Runtime services backed by the given local sandbox: sandbox filesystem
 * service plus the sandbox's own local capabilities (process spawner, ...).
 * For bash-wrapped local sandboxes use `EnvBash.services`, which keeps the
 * Shell type.
 */
export const services = <E, RIn>(sandbox: Sandbox<E, RIn>) => Layer.provideMerge(Virtual.layer, sandbox);

/** Default sandbox: the real OS filesystem and processes with relative paths resolved from `cwd`. */
export const defaultLayer = (cwd: string) => services(EnvDefault.layer({ cwd }));

export * as Sandbox from "./sandbox";
