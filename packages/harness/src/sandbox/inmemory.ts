import { create, MemoryProvider } from "@platformatic/vfs";
import { Layer } from "effect";
import { FileSystem } from "../filesystem/filesystem";

export interface Options {
	/** Freeze the provider to prevent writes. Defaults to false. */
	readonly readOnly?: boolean;
}

// A purely in-memory filesystem with no backing resource to release; every
// layer build gets its own fresh, isolated tree.
export const layer = (options?: Options) =>
	Layer.sync(FileSystem.Vfs, () => {
		const provider = new MemoryProvider();
		// Freeze the provider to prevent writes
		if (options?.readOnly) provider.setReadOnly();
		return create(provider, { moduleHooks: false });
	});

export * as EnvInMemory from "./inmemory";
