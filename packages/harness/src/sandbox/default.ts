import { create, RealFSProvider } from "@platformatic/vfs";
import { FileSystem } from "../filesystem/filesystem";

export const layer = (rootPath: string) =>
	FileSystem.layerFromVfs(
		create(new RealFSProvider(rootPath), {
			moduleHooks: false,
		}),
	);

export * as EnvDefault from "./default";
