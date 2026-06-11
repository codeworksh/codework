import { create, SqliteProvider } from "@platformatic/vfs";
import { Effect, Layer } from "effect";
import { FileSystem } from "../filesystem/filesystem";
import { Process } from "./process";

// SqliteProvider holds a single node:sqlite connection for the lifetime of
// the layer; omitting `location` keeps the whole filesystem in `:memory:`.
const vfsLayer = (location?: string) =>
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

export const layer = (location?: string) => Layer.merge(vfsLayer(location), Process.unsupported);

export * as EnvSqldb from "./sqldb";
