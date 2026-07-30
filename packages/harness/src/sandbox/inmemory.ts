import { create, MemoryProvider } from "@platformatic/vfs";
import { Effect, Layer } from "effect";
import { Local } from "./filesystem/local";
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

/** Build one namespace. Drivers keep this value beyond transport-cache eviction. */
export const make = (options?: Options) =>
	Effect.tryPromise({
		try: async () => {
			const provider = new MemoryProvider();
			const vfs = create(provider, { moduleHooks: false, virtualCwd: true });

			await Seed.initialize(vfs, options);
			if (options?.readOnly) provider.setReadOnly();
			return vfs;
		},
		catch: (cause) => cause,
	});

// A purely in-memory filesystem with no backing resource to release; every
// layer build gets its own fresh, isolated tree.
export const layer = (options?: Options) =>
	Layer.merge(
		Layer.effect(Local.Vfs, make(options).pipe(Effect.orDie)),
		options?.hostProcess ? Process.host : Process.unsupported,
	);

export * as EnvInMemory from "./inmemory";
