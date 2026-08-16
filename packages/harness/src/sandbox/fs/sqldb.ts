/* oxlint-disable effecttsgo/async-function -- VFS operations implement a Promise-based adapter contract. */
import { create, SqliteProvider } from "@platformatic/vfs";
import { Effect, Layer, Schema } from "effect";
import { Process } from "../utils/process.ts";
import { Seed, type SeedOptions } from "../utils/seed.ts";
import { Local } from "./vfs.ts";

export class SqldbError extends Schema.TaggedError<SqldbError>()("SqldbError", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

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
		catch: (cause) =>
			new SqldbError({
				message: "Failed to initialize the SQLite filesystem",
				cause,
			}),
	});

const vfsLayer = (location?: string, options?: Options) =>
	Layer.effect(
		Local.Vfs,
		Effect.acquireRelease(make(location, options), ({ provider }) => Effect.sync(() => provider.close())).pipe(
			Effect.map(({ vfs }) => vfs),
		),
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

export * as EnvSqldb from "./sqldb.ts";
