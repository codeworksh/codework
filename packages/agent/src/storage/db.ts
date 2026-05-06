import { createClient, type Client as LibSQLClient, type ResultSet } from "@libsql/client";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { SQLiteTransaction } from "drizzle-orm/sqlite-core";

export * from "drizzle-orm"; // export drizzle-orm exports from here

import { Global } from "../config/global";
import { lazy, NamedError } from "@codeworksh/utils";
import Type from "typebox";
import path from "path";
import { fileURLToPath } from "url";
import { Context } from "../util/context";
import { Log } from "../util/log";
import * as schema from "./schema";

export const NotFoundError = NamedError.create(
	"NotFoundError",
	Type.Object({
		message: Type.String(),
	}),
);

const log = Log.create({ service: "db" });

export namespace Database {
	export const Path = path.join(Global.Path.data, "codework.db");
	type Schema = typeof schema;
	export type Transaction = SQLiteTransaction<"async", ResultSet, Schema, ExtractTablesWithRelations<Schema>>;

	type Client = LibSQLDatabase<Schema>;

	const state = {
		sqlite: undefined as LibSQLClient | undefined,
	};

	export const Client = lazy(async () => {
		log.info("opening database", {
			path: Path,
		});

		const sqlite = createClient({
			url: `file:${Path}`,
		});
		state.sqlite = sqlite;

		await sqlite.execute("PRAGMA journal_mode = WAL");
		await sqlite.execute("PRAGMA synchronous = NORMAL");
		await sqlite.execute("PRAGMA busy_timeout = 5000");
		await sqlite.execute("PRAGMA cache_size = -64000");
		await sqlite.execute("PRAGMA foreign_keys = ON");
		await sqlite.execute("PRAGMA wal_checkpoint(PASSIVE)");

		const db = drizzle({ client: sqlite, schema });
		const dirname = path.dirname(fileURLToPath(import.meta.url));

		await migrate(db, {
			migrationsFolder: path.join(dirname, "../../migrations"),
		});

		return db;
	});

	export function close() {
		const sqlite = state.sqlite;
		if (!sqlite) return;
		sqlite.close();
		state.sqlite = undefined;
		Client.reset();
	}

	export type TxOrDb = Transaction | Client;

	const ctx = Context.create<{
		tx: TxOrDb;
		effects: (() => void | Promise<void>)[];
	}>("database");

	export async function use<T>(callback: (trx: TxOrDb) => T | Promise<T>): Promise<T> {
		try {
			return await callback(ctx.use().tx);
		} catch (err) {
			if (err instanceof Context.NotFound) {
				const effects: (() => void | Promise<void>)[] = [];
				const db = await Client();
				const result = await ctx.provide({ effects, tx: db }, () => callback(db));
				for (const effect of effects) await effect();
				return result;
			}
			throw err;
		}
	}

	export function effect(fn: () => void | Promise<void>) {
		try {
			ctx.use().effects.push(fn);
		} catch {
			void fn();
		}
	}

	export async function transaction<T>(callback: (tx: TxOrDb) => T | Promise<T>): Promise<T> {
		try {
			return await callback(ctx.use().tx);
		} catch (err) {
			if (err instanceof Context.NotFound) {
				const effects: (() => void | Promise<void>)[] = [];
				const db = await Client();
				const result = await db.transaction(async (tx) => {
					return await ctx.provide({ tx, effects }, () => callback(tx));
				});
				for (const effect of effects) await effect();
				return result as T;
			}
			throw err;
		}
	}
}
