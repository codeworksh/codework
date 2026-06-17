import { create } from "@platformatic/vfs";
import { Layer } from "effect";
import { FileSystem } from "../filesystem/filesystem";
import { Process } from "./utils/process";
import { ConfinedRealFSProvider } from "./utils/realfs";

export const layer = (rootPath: string) =>
	Layer.merge(
		FileSystem.layerFromVfs(
			create(new ConfinedRealFSProvider(rootPath), {
				moduleHooks: false,
			}),
		),
		Process.host,
	);

export * as EnvDefault from "./default";
