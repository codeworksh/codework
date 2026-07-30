import { create, SqliteProvider } from "@platformatic/vfs";
import { Effect, Layer } from "effect";
import { Local } from "./filesystem/local";
import { Process } from "./utils/process";
import { Seed, type SeedOptions } from "./utils/seed";

// SqliteProvider holds a single node:sqlite connection for the lifetime of
// the layer; omitting `location` keeps the whole filesystem in `:memory:`.
export interface Namespace {
	readonly provider: SqliteProvider;
	readonly vfs: ReturnType<typeof create>;
}

export const make = (location?: string, options?: Options) =>
	Effect.tryPromise({
		try: async (): Promise<Namespace> => {
			const provider = new SqliteProvider(location);
			try {
				const vfs = create(provider, { moduleHooks: false, virtualCwd: true });

				await Seed.initialize(vfs, options);
				if (options?.readOnly) provider.setReadOnly();

				return { provider, vfs };
			} catch (error) {
				provider.close();
				throw error;
			}
		},
		catch: (cause) => cause,
	});

const vfsLayer = (location?: string, options?: Options) =>
	Layer.effect(
		Local.Vfs,
		Effect.acquireRelease(make(location, options).pipe(Effect.orDie), ({ provider }) =>
			Effect.sync(() => provider.close()),
		).pipe(Effect.map(({ vfs }) => vfs)),
	);

export interface Options extends SeedOptions {
	/** Freeze the provider to prevent writes. Defaults to false. */
	readonly readOnly?: boolean;
	/**
	 * Spawn child processes on the host OS even though the filesystem is
	 * virtual. Defaults to false: process execution is refused.
	 */
	readonly hostProcess?: boolean;
}

interface LayerOptions {
	location?: string;
	options?: Options;
}

export const layer = (opts?: LayerOptions) =>
	Layer.merge(
		vfsLayer(opts?.location, opts?.options),
		opts?.options?.hostProcess ? Process.host : Process.unsupported,
	);

export * as EnvSqldb from "./sqldb";
