import { Layer } from "effect";
import { FileSystem } from "../filesystem/filesystem";
import { EnvDefault } from "./default";

// re-export from sandbox
export { EnvDefault } from "./default";
export { EnvSqldb } from "./sqldb";

/**
 * The OS-primitive capabilities every sandbox must provide. Currently the
 * filesystem backend; networking, process execution, etc. join this union
 * as they become sandboxed.
 */
export type Provides = FileSystem.Vfs;

/**
 * A sandbox is any Layer providing the OS primitives — this type is the
 * entire plugin contract. Swap implementations (envDefault, envInmemory,
 * envRemote, ...) at the composition root and the application is unchanged.
 */
export type Sandbox<E = never, RIn = never> = Layer.Layer<Provides, E, RIn>;

/** App-facing filesystem service backed by the given sandbox. */
export const filesystem = <E, RIn>(sandbox: Sandbox<E, RIn>) => FileSystem.layer.pipe(Layer.provide(sandbox));

/** Default sandbox: the real OS filesystem rooted at `rootPath`. */
export const defaultLayer = (rootPath: string) => filesystem(EnvDefault.layer(rootPath));

export * as Sandbox from "./sandbox";
