import { create, MemoryProvider } from "@platformatic/vfs";
import { Layer } from "effect";
import { FileSystem } from "../filesystem/filesystem";
import { Process } from "./process";

export interface Options {
	/** Freeze the provider to prevent writes. Defaults to false. */
	readonly readOnly?: boolean;
	/**
	 * Spawn child processes on the host OS even though the filesystem is
	 * virtual. Defaults to false: process execution is refused.
	 */
	readonly hostProcess?: boolean;
}

// A purely in-memory filesystem with no backing resource to release; every
// layer build gets its own fresh, isolated tree.
export const layer = (options?: Options) =>
	Layer.merge(
		Layer.sync(FileSystem.Vfs, () => {
			const provider = new MemoryProvider();
			// Freeze the provider to prevent writes
			if (options?.readOnly) provider.setReadOnly();
			return create(provider, { moduleHooks: false });
		}),
		options?.hostProcess ? Process.host : Process.unsupported,
	);

export * as EnvInMemory from "./inmemory";
