import type { InferInsertModel, InferSelectModel, SQL } from "drizzle-orm";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { SelectedFields, SelectedFieldsFlat } from "drizzle-orm/sqlite-core/query-builders/select.types";
import { Context, Effect, Layer, Schema } from "effect";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync, type DatabaseSyncOptions, type StatementResultingChanges } from "node:sqlite";
import { Global } from "../global";

export * from "drizzle-orm";

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
	method: Schema.String,
	cause: Schema.Unknown,
}) {}

export type SchemaShape = Record<string, unknown>;
export type RawDatabaseShape<TSchema extends SchemaShape = Record<string, never>> = NodeSQLiteDatabase<TSchema>;
export type RunResult = StatementResultingChanges;

// Terminal methods shared by every builder once it is executable.
export interface ExecuteShape<TResult> {
	readonly all: () => Effect.Effect<TResult[], DatabaseError>;
	readonly get: () => Effect.Effect<TResult | undefined, DatabaseError>;
	readonly run: () => Effect.Effect<RunResult, DatabaseError>;
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
	readonly run: () => Effect.Effect<RunResult, DatabaseError>;
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
	readonly run: () => Effect.Effect<RunResult, DatabaseError>;
}

export interface UpdateShape<TTable extends SQLiteTable> {
	readonly set: (values: UpdateSetSource<TTable>) => UpdateQueryShape<TTable>;
}

export interface DeleteQueryShape<TTable extends SQLiteTable> extends ReturningShape<TTable> {
	readonly where: (where: SQL | undefined) => DeleteQueryShape<TTable>;
	readonly run: () => Effect.Effect<RunResult, DatabaseError>;
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
	readonly run: (query: unknown) => Effect.Effect<RunResult, DatabaseError>;
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
}

export class Sqlite extends Context.Service<Sqlite, DatabaseSync>()("@codework/db/Sqlite") {}
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

				if (terminalMethods.has(method)) {
					// node:sqlite executes synchronously, so terminal methods are
					// deferred into an Effect and run on subscription. A promise
					// result is still tolerated for forward compatibility.
					const invoke =
						method === "transaction"
							? () => {
									const [callback, ...rest] = args;
									return value.call(
										target,
										(tx: object) => {
											const txResult = (callback as (tx: unknown) => unknown)(wrap(tx, cache));
											// node:sqlite transactions are synchronous: an Effect
											// callback must not cross an async boundary.
											return Effect.isEffect(txResult)
												? Effect.runSync(txResult as Effect.Effect<unknown, unknown, never>)
												: txResult;
										},
										...rest,
									);
								}
							: () => value.apply(target, args);

					return Effect.try({
						try: invoke,
						catch: (cause) => toDatabaseError(method, cause),
					}).pipe(
						Effect.flatMap((result) =>
							isPromiseLike(result) ? effectify(result, method) : Effect.succeed(result),
						),
					);
				}

				return wrapResult(value.apply(target, args), cache);
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
		const client = yield* Sqlite;
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

			return Service.of({ db });
		}).pipe(Effect.orDie),
	);

export const layer = layerWith();

// node:sqlite holds a single connection for the lifetime of the layer, so a
// `:memory:` database stays intact across transactions — important for
// serverless deployments where no writable disk is available.
export function sqliteLayer(location: string, options?: DatabaseSyncOptions) {
	return Layer.effect(
		Sqlite,
		Effect.acquireRelease(
			Effect.tryPromise({
				try: async () => {
					if (location !== ":memory:") {
						await fs.mkdir(dirname(location), { recursive: true });
					}
					return new DatabaseSync(location, options ?? {});
				},
				catch: (cause) => toDatabaseError("open", cause),
			}),
			(client) => Effect.sync(() => client.close()),
		),
	);
}

export function layerFromPath<TSchema extends SchemaShape = Record<string, never>>(
	filename: string,
	options: LayerOptions<TSchema> = {},
) {
	return layerWith(options).pipe(Layer.provide(sqliteLayer(filename)));
}

export function path() {
	const envPath = process.env.CODEWORK_DB;
	if (envPath) {
		if (envPath === ":memory:" || isAbsolute(envPath)) return envPath;
		return join(Global.Path.data, envPath);
	}
	return join(Global.Path.data, "codework.db");
}

const migrationsFolder = join(import.meta.dirname, "../../migrations");

export const migrateDefault = <TSchema extends SchemaShape = Record<string, never>>(db: RawDatabaseShape<TSchema>) =>
	Effect.try({
		try: () => void migrate(db, { migrationsFolder }),
		catch: (cause) => toDatabaseError("migrate", cause),
	});

export const defaultLayer = Layer.unwrap(Effect.sync(() => layerFromPath(path(), { migrate: migrateDefault }))).pipe(
	Layer.provide(Global.defaultLayer),
);

export * as Database from "./db";
