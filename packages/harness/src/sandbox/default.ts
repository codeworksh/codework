import { create, RealFSProvider } from "@platformatic/vfs";
import { Layer } from "effect";
import { FileSystem } from "../filesystem/filesystem";
import { Process } from "./process";

export const layer = (rootPath: string) =>
	Layer.merge(
		FileSystem.layerFromVfs(
			create(new RealFSProvider(rootPath), {
				moduleHooks: false,
			}),
		),
		Process.host,
	);

export * as EnvDefault from "./default";
