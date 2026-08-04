import type { VirtualFileSystem } from "@platformatic/vfs";
import { Layer } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { SandboxFileSystem } from "./fs/filesystem";
import { Local } from "./fs/vfs";
import { EnvBash } from "./shell/justbash";
import { Shell } from "./shell/shell";
import { Process } from "./utils/process";

type Primitives = Local.Vfs | ChildProcessSpawner.ChildProcessSpawner;

export const transportLayer = <E, R>(
	primitives: Layer.Layer<Primitives, E, R>,
): Layer.Layer<SandboxFileSystem.Service | Shell, E, R> =>
	Layer.provideMerge(Layer.merge(Local.layer, EnvBash.transport(primitives)), primitives);

/** A cwd-neutral FileSystem + just-bash transport over one retained VFS. */
export const transport = (vfs: VirtualFileSystem): Layer.Layer<SandboxFileSystem.Service | Shell> => {
	const primitives = Layer.merge(Layer.succeed(Local.Vfs, vfs), Process.unsupported);
	return transportLayer(primitives);
};
