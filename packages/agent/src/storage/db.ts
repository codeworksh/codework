import { Database as BunDatabase } from "bun:sqlite";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { SQLiteTransaction } from "drizzle-orm/sqlite-core";

export * from "drizzle-orm"; // export drizzle-orm exports from here

import { Global } from "../config/global";
import { lazy, NamedError } from "@codeworksh/utils";
import { Type } from "@sinclair/typebox";
import path from "path";
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
	export type Transaction = SQLiteTransaction<"sync", void, Schema, ExtractTablesWithRelations<Schema>>;

	type Client = BunSQLiteDatabase<Schema>;

	const state = {
		sqlite: undefined as BunDatabase | undefined,
	};

	export const Client = lazy(() => {
		log.info("opening database", {
			path: path.join(Global.Path.data, "codework.db"),
		});

		const sqlite = new BunDatabase(path.join(Global.Path.data, "codework.db"), {
			create: true,
		});
		state.sqlite = sqlite;

		sqlite.run("PRAGMA journal_mode = WAL");
		sqlite.run("PRAGMA synchronous = NORMAL");
		sqlite.run("PRAGMA busy_timeout = 5000");
		sqlite.run("PRAGMA cache_size = -64000");
		sqlite.run("PRAGMA foreign_keys = ON");
		sqlite.run("PRAGMA wal_checkpoint(PASSIVE)");

		const db = drizzle({ client: sqlite, schema });

		migrate(db, {
			migrationsFolder: path.join(import.meta.dir, "../../../migrations"),
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

	export function use<T>(callback: (trx: TxOrDb) => T): T {
		try {
			return callback(ctx.use().tx);
		} catch (err) {
			if (err instanceof Context.NotFound) {
				const effects: (() => void | Promise<void>)[] = [];
				const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()));
				for (const effect of effects) effect();
				return result;
			}
			throw err;
		}
	}

	export function effect(fn: () => any | Promise<any>) {
		try {
			ctx.use().effects.push(fn);
		} catch {
			fn();
		}
	}

	export function transaction<T>(callback: (tx: TxOrDb) => T): T {
		try {
			return callback(ctx.use().tx);
		} catch (err) {
			if (err instanceof Context.NotFound) {
				const effects: (() => void | Promise<void>)[] = [];
				const result = Client().transaction((tx) => {
					return ctx.provide({ tx, effects }, () => callback(tx));
				});
				for (const effect of effects) effect();
				return result;
			}
			throw err;
		}
	}
}
