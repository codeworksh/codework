import { create, MemoryProvider } from "@platformatic/vfs";
import { Effect, Layer } from "effect";
import { FileSystem } from "../filesystem/filesystem";
import { Process } from "./utils/process";
import { Seed, type SeedOptions } from "./utils/seed";

export interface Options extends SeedOptions {
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
		Layer.effect(
			FileSystem.Vfs,
			Effect.promise(async () => {
				const provider = new MemoryProvider();
				const vfs = create(provider, { moduleHooks: false, virtualCwd: true });

				await Seed.initialize(vfs, options);
				if (options?.readOnly) provider.setReadOnly();
				return vfs;
			}),
		),
		options?.hostProcess ? Process.host : Process.unsupported,
	);

export * as EnvInMemory from "./inmemory";
