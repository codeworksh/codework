import { createClient, type Client as LibsqlClient, type Config as LibsqlConfig, type ResultSet } from "@libsql/client";
import type { InferInsertModel, InferSelectModel, SQL } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { SelectedFields, SelectedFieldsFlat } from "drizzle-orm/sqlite-core/query-builders/select.types";
import { Context, Effect, Layer, Schema } from "effect";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Global } from "../global";

export * from "drizzle-orm";

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
	method: Schema.String,
	cause: Schema.Unknown,
}) {}

export type SchemaShape = Record<string, unknown>;
export type RawDatabaseShape<TSchema extends SchemaShape = Record<string, never>> = LibSQLDatabase<TSchema>;

// Terminal methods shared by every builder once it is executable.
export interface ExecuteShape<TResult> {
	readonly all: () => Effect.Effect<TResult[], DatabaseError>;
	readonly get: () => Effect.Effect<TResult | undefined, DatabaseError>;
	readonly run: () => Effect.Effect<ResultSet, DatabaseError>;
	readonly execute: () => Effect.Effect<TResult[], DatabaseError>;
}

export type OrderByTerm = SQLiteColumn | SQL | SQL.Aliased;

export interface SelectQueryShape<TResult> extends ExecuteShape<TResult> {
	readonly where: (where: SQL | undefined) => SelectQueryShape<TResult>;
	readonly orderBy: (...columns: ReadonlyArray<OrderByTerm>) => SelectQueryShape<TResult>;
	readonly groupBy: (...columns: ReadonlyArray<OrderByTerm>) => SelectQueryShape<TResult>;
	readonly having: (having: SQL | undefined) => SelectQueryShape<TResult>;
	readonly limit: (limit: number) => SelectQueryShape<TResult>;
	readonly offset: (offset: number) => SelectQueryShape<TResult>;
}

// `TSelection` is `undefined` for a bare `select()`, in which case the row
// type is inferred from the table passed to `from`.
export interface SelectFromShape<TSelection> {
	readonly from: <TFrom extends SQLiteTable>(
		source: TFrom,
	) => SelectQueryShape<[TSelection] extends [undefined] ? InferSelectModel<TFrom> : TSelection>;
}

export interface ReturningShape<TTable extends SQLiteTable> {
	readonly returning: {
		(): ExecuteShape<InferSelectModel<TTable>>;
		<TSelection extends SelectedFieldsFlat>(fields: TSelection): ExecuteShape<SelectResultFields<TSelection>>;
	};
}

export interface InsertQueryShape<TTable extends SQLiteTable> extends ReturningShape<TTable> {
	readonly run: () => Effect.Effect<ResultSet, DatabaseError>;
	readonly onConflictDoNothing: (config?: unknown) => InsertQueryShape<TTable>;
	readonly onConflictDoUpdate: (config: unknown) => InsertQueryShape<TTable>;
}

export interface InsertShape<TTable extends SQLiteTable> {
	readonly values: (
		values: InferInsertModel<TTable> | ReadonlyArray<InferInsertModel<TTable>>,
	) => InsertQueryShape<TTable>;
}

export type UpdateSetSource<TTable extends SQLiteTable> = {
	readonly [K in keyof InferInsertModel<TTable>]?: InferInsertModel<TTable>[K] | SQL;
};

export interface UpdateQueryShape<TTable extends SQLiteTable> extends ReturningShape<TTable> {
	readonly where: (where: SQL | undefined) => UpdateQueryShape<TTable>;
	readonly run: () => Effect.Effect<ResultSet, DatabaseError>;
}

export interface UpdateShape<TTable extends SQLiteTable> {
	readonly set: (values: UpdateSetSource<TTable>) => UpdateQueryShape<TTable>;
}

export interface DeleteQueryShape<TTable extends SQLiteTable> extends ReturningShape<TTable> {
	readonly where: (where: SQL | undefined) => DeleteQueryShape<TTable>;
	readonly run: () => Effect.Effect<ResultSet, DatabaseError>;
}

export interface DatabaseShape {
	readonly select: {
		(): SelectFromShape<undefined>;
		<TSelection extends SelectedFields>(fields: TSelection): SelectFromShape<SelectResultFields<TSelection>>;
	};
	readonly selectDistinct: {
		(): SelectFromShape<undefined>;
		<TSelection extends SelectedFields>(fields: TSelection): SelectFromShape<SelectResultFields<TSelection>>;
	};
	readonly insert: <TTable extends SQLiteTable>(table: TTable) => InsertShape<TTable>;
	readonly update: <TTable extends SQLiteTable>(table: TTable) => UpdateShape<TTable>;
	readonly delete: <TTable extends SQLiteTable>(table: TTable) => DeleteQueryShape<TTable>;
	readonly run: (query: unknown) => Effect.Effect<ResultSet, DatabaseError>;
	readonly all: <TResult = unknown>(query: unknown) => Effect.Effect<TResult[], DatabaseError>;
	readonly get: <TResult = unknown>(query: unknown) => Effect.Effect<TResult | undefined, DatabaseError>;
	readonly values: <TResult extends unknown[] = unknown[]>(query: unknown) => Effect.Effect<TResult[], DatabaseError>;
	readonly transaction: <A>(
		callback: (tx: DatabaseShape) => Effect.Effect<A, DatabaseError> | PromiseLike<A> | A,
		config?: unknown,
	) => Effect.Effect<A, DatabaseError>;
	readonly [key: string]: unknown;
}

export interface Interface {
	readonly db: DatabaseShape;
	readonly client: LibsqlClient;
}

export class Libsql extends Context.Service<Libsql, LibsqlClient>()("@codework/db/Libsql") {}
export class Service extends Context.Service<Service, Interface>()("@codework/db/Database") {}

export interface LayerOptions<TSchema extends SchemaShape = Record<string, never>> {
	readonly schema?: TSchema;
	readonly migrate?: (db: RawDatabaseShape<TSchema>) => Effect.Effect<void, DatabaseError>;
}

const terminalMethods = new Set(["all", "get", "run", "execute", "transaction"]);

function toDatabaseError(method: string, cause: unknown) {
	return new DatabaseError({ method, cause });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof (value as { then: unknown }).then === "function"
	);
}

function effectify<T>(promise: PromiseLike<T>, method: string) {
	return Effect.tryPromise({
		try: () => Promise.resolve(promise),
		catch: (cause) => toDatabaseError(method, cause),
	});
}

function wrap<T extends object>(input: T, cache = new WeakMap<object, unknown>()): DatabaseShape {
	const cached = cache.get(input);
	if (cached) return cached as DatabaseShape;

	const wrapped = new Proxy(input, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") {
				if (typeof value === "object" && value !== null) return wrap(value, cache);
				return value;
			}

			return (...args: unknown[]) => {
				const method = String(property);

				if (method === "transaction") {
					const [callback, ...rest] = args;
					const result = value.call(
						target,
						(tx: object) => {
							const txResult = (callback as (tx: unknown) => unknown)(wrap(tx, cache));
							return Effect.isEffect(txResult)
								? Effect.runPromise(txResult as Effect.Effect<unknown, unknown, never>)
								: txResult;
						},
						...rest,
					);
					return isPromiseLike(result) ? effectify(result, method) : wrapResult(result, cache);
				}

				const result = value.apply(target, args);
				if (terminalMethods.has(method) && isPromiseLike(result)) return effectify(result, method);
				return wrapResult(result, cache);
			};
		},
	});

	cache.set(input, wrapped);
	return wrapped as DatabaseShape;
}

function wrapResult(value: unknown, cache: WeakMap<object, unknown>): unknown {
	if (typeof value === "object" && value !== null) return wrap(value, cache);
	return value;
}

export const makeDatabase = <TSchema extends SchemaShape = Record<string, never>>(
	options: LayerOptions<TSchema> = {},
) =>
	Effect.gen(function* () {
		const client = yield* Libsql;
		const raw = drizzle({ client, schema: options.schema });
		return {
			raw,
			db: wrap(raw) as DatabaseShape,
		};
	});

export const layerWith = <TSchema extends SchemaShape = Record<string, never>>(options: LayerOptions<TSchema> = {}) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const { raw, db } = yield* makeDatabase(options);

			yield* db.run("PRAGMA journal_mode = WAL");
			yield* db.run("PRAGMA synchronous = NORMAL");
			yield* db.run("PRAGMA busy_timeout = 5000");
			yield* db.run("PRAGMA cache_size = -64000");
			yield* db.run("PRAGMA foreign_keys = ON");
			yield* db.run("PRAGMA wal_checkpoint(PASSIVE)");
			if (options.migrate) yield* options.migrate(raw);

			const client = yield* Libsql;
			return Service.of({ db, client });
		}).pipe(Effect.orDie),
	);

export const layer = layerWith();

export function sqliteLayer(config: LibsqlConfig | string) {
	return Layer.effect(
		Libsql,
		Effect.acquireRelease(
			Effect.tryPromise({
				try: async () => {
					if (typeof config === "string" && config !== ":memory:" && config.startsWith("file:")) {
						await fs.mkdir(dirname(config.slice("file:".length)), { recursive: true });
					}
					return createClient(typeof config === "string" ? { url: config } : config);
				},
				catch: (cause) => toDatabaseError("createClient", cause),
			}),
			(client) => Effect.sync(() => client.close()),
		),
	);
}

export function layerFromPath<TSchema extends SchemaShape = Record<string, never>>(
	filename: string,
	options: LayerOptions<TSchema> = {},
) {
	const url = filename === ":memory:" ? "file::memory:" : `file:${filename}`;
	return layerWith(options).pipe(Layer.provide(sqliteLayer(url)));
}

export function path() {
	const envPath = process.env.CODEWORK_DB;
	if (envPath) {
		if (envPath === ":memory:" || isAbsolute(envPath)) return envPath;
		return join(Global.Path.data, envPath);
	}
	return join(Global.Path.data, "codework.db");
}

export const defaultLayer = Layer.unwrap(Effect.sync(() => layerFromPath(path()))).pipe(
	Layer.provide(Global.defaultLayer),
);

export * as Database from "./db";
