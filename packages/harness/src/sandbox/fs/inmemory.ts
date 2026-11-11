/* oxlint-disable effecttsgo/async-function -- VFS operations implement a Promise-based adapter contract. */
import { create, MemoryProvider } from "@platformatic/vfs";
import { Effect, Layer, Schema } from "effect";
import * as Process from "../utils/process.ts";
import * as Seed from "../utils/seed.ts";
import { type SeedOptions } from "../utils/seed.ts";
import * as Local from "./vfs.ts";

class InMemoryError extends Schema.TaggedError<InMemoryError>()("InMemoryError", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

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
		catch: (cause) =>
			new InMemoryError({
				message: "Failed to initialize the in-memory filesystem",
				cause,
			}),
	});

// A purely in-memory filesystem with no backing resource to release; every
// layer build gets its own fresh, isolated tree.
export const layer = (options?: Options) =>
	Layer.merge(Layer.effect(Local.Vfs, make(options)), options?.hostProcess ? Process.host : Process.unsupported);
