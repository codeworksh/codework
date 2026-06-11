import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node";
import { create, RealFSProvider } from "@platformatic/vfs";
import { Layer } from "effect";
import { FileSystem } from "../filesystem/filesystem";

export const layer = (rootPath: string) =>
	Layer.merge(
		FileSystem.layerFromVfs(
			create(new RealFSProvider(rootPath), {
				moduleHooks: false,
			}),
		),
		NodeChildProcessSpawner.layer.pipe(Layer.provide([NodeFileSystem.layer, NodePath.layer])),
	);

export * as EnvDefault from "./default";
