import type { VirtualFileSystem } from "@platformatic/vfs";
import { Layer } from "effect";
import { SandboxFileSystem } from "../filesystem/filesystem";
import { Local } from "../filesystem/local";
import { EnvBash } from "../justbashexe";
import { Shell } from "../shell";
import { Process } from "../utils/process";

type Primitives = Local.Vfs | import("effect/unstable/process").ChildProcessSpawner.ChildProcessSpawner;

export const transportLayer = <E, R>(
	primitives: Layer.Layer<Primitives, E, R>,
): Layer.Layer<SandboxFileSystem.Service | Shell, E, R> =>
	Layer.provideMerge(Layer.merge(Local.layer, EnvBash.transport(primitives)), primitives);

/** A cwd-neutral FileSystem + just-bash transport over one retained VFS. */
export const transport = (vfs: VirtualFileSystem): Layer.Layer<SandboxFileSystem.Service | Shell> => {
	const primitives = Layer.merge(Layer.succeed(Local.Vfs, vfs), Process.unsupported);
	return transportLayer(primitives);
};
