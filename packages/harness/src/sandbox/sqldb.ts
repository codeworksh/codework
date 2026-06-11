import { create, SqliteProvider } from "@platformatic/vfs";
import { Effect, Layer } from "effect";
import { FileSystem } from "../filesystem/filesystem";

// SqliteProvider holds a single node:sqlite connection for the lifetime of
// the layer; omitting `location` keeps the whole filesystem in `:memory:`.
export const layer = (location?: string) =>
	Layer.effect(
		FileSystem.Vfs,
		Effect.acquireRelease(
			Effect.sync(() => {
				const provider = new SqliteProvider(location);
				const vfs = create(provider, { moduleHooks: false });
				return { provider, vfs };
			}),
			({ provider }) => Effect.sync(() => provider.close()),
		).pipe(Effect.map(({ vfs }) => vfs)),
	);

export * as EnvSqldb from "./sqldb";
