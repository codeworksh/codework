import { Clock, Config, Context, Effect, FileSystem, Layer, Schema, Stream, SubscriptionRef } from "effect";
import { SqlClient } from "effect/sql";
/* @effect-diagnostics nodeBuiltinImport:off -- paths typed in Settings expand against the OS home directory. */
import os from "node:os";
import path from "node:path";
import { type CliEnvVar, LOCAL_SERVER, type ServerAdd, ServersError, type ServerUpdate } from "@codeworksh/contract";

/** The same home the CLI resolves: CODEWORK_HOME_DIR, else ~/.codework. Only the built-in server falls back to it. */
const cliHome = Config.String("CODEWORK_HOME_DIR").pipe(Config.withDefault(path.join(os.homedir(), ".codework")));

// Stored with every value; only the app server reads the sensitive ones.
export const StoredEnv = Schema.Array(
	Schema.Struct({ name: Schema.String, value: Schema.String, sensitive: Schema.Boolean }),
);
export type StoredEnv = typeof StoredEnv.Type;

/** Splits typed arguments as a shell would for plain words and quotes: `--name "a b"` is two. */
export const splitArgs = (input: string) =>
	[...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");

/** A server as stored. A `null` executable or home is the one found. An executable is a path, or a
 * command whose first word is one (`node --conditions=development …/index.ts`, running from source). */
export interface Row {
	readonly id: string;
	readonly kind: "local";
	readonly name: string;
	readonly executable: string | null;
	readonly home: string | null;
	readonly args: string;
	readonly env: StoredEnv;
	readonly isDefault: boolean;
}

const decodeEnv = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredEnv));

const fail = (message: string) => new ServersError({ message });

/** A path typed in Settings: `~` is the user's home; blank means none; anything else must be absolute. */
const chosenPath = (input: string | null) =>
	Effect.gen(function* () {
		const trimmed = input?.trim() ?? "";
		if (trimmed === "") return null;
		const expanded =
			trimmed === "~" || trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
		if (!path.isAbsolute(expanded))
			return yield* fail("Use a full path, such as ~/.codework or /usr/local/bin/codework.");
		return path.normalize(expanded);
	});

const quoted = (word: string) => (/\s/.test(word) ? `"${word}"` : word);

/**
 * An executable typed in Settings: a path as {@link chosenPath}, optionally followed by arguments.
 * A typed path naming a file is that file even with spaces in it, as an install folder may have.
 */
const chosenCommand = (fs: FileSystem.FileSystem, input: string | null) =>
	Effect.gen(function* () {
		const whole = yield* chosenPath(input).pipe(Effect.orElseSucceed(() => null));
		if (whole !== null && (yield* fs.exists(whole).pipe(Effect.orElseSucceed(() => false)))) return quoted(whole);
		const [program, ...rest] = splitArgs(input ?? "");
		const file = yield* chosenPath(program ?? null);
		if (file === null) return null;
		// `~/…` arguments expand too, so a source entry can be typed as it reads in a terminal.
		const args = rest.map((word) => (word.startsWith("~/") ? path.join(os.homedir(), word.slice(1)) : word));
		return [file, ...args].map(quoted).join(" ");
	});

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variables as chosen: names must be shell names, once each, and leave the home to its own
 * setting; a sensitive one sent without a value keeps the saved value.
 */
const nextEnv = (chosen: ReadonlyArray<CliEnvVar>, saved: StoredEnv) =>
	Effect.gen(function* () {
		const names = new Set<string>();
		const next: Array<StoredEnv[number]> = [];
		for (const { name: raw, sensitive, value } of chosen) {
			const name = raw.trim();
			if (!VARIABLE_NAME.test(name))
				return yield* fail(`${name || "A blank name"} is not a variable name: use letters, digits and _.`);
			if (name === "CODEWORK_HOME_DIR") return yield* fail("Set CODEWORK_HOME_DIR with the home path above.");
			if (names.has(name)) return yield* fail(`${name} is set twice.`);
			names.add(name);
			// Only a variable that stays sensitive keeps its saved value, so none is ever revealed by unmarking it.
			const kept = sensitive
				? saved.find((variable) => variable.name === name && variable.sensitive)?.value
				: undefined;
			next.push({ name, sensitive, value: value ?? kept ?? "" });
		}
		return next;
	});

/**
 * The servers the app knows, and the one it connects to: the default, whose home's `service.json`
 * names the server. The built-in local server is always there.
 */
export class Service extends Context.Service<
	Service,
	{
		readonly list: Effect.Effect<ReadonlyArray<Row>>;
		readonly get: (id: string) => Effect.Effect<Row, ServersError>;
		/** The home a server uses; `fallback` is the built-in server's when none is chosen. */
		readonly homeOf: (row: Row) => {
			readonly path: string;
			readonly custom: boolean;
			readonly fallback: string | null;
		};
		/** The default server's home. */
		readonly defaultHome: Effect.Effect<string>;
		/** The default server's home each time it changes, without the current one. */
		readonly homeChanges: Stream.Stream<string>;
		readonly add: (input: ServerAdd) => Effect.Effect<string, ServersError>;
		readonly update: (input: ServerUpdate) => Effect.Effect<void, ServersError>;
		readonly remove: (id: string) => Effect.Effect<void, ServersError>;
		readonly setDefault: (id: string) => Effect.Effect<void, ServersError>;
	}
>()("@codeworksh/server/servers/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const fs = yield* FileSystem.FileSystem;
		const fallback = yield* cliHome.pipe(Effect.orDie);

		const list = sql<Omit<Row, "env" | "isDefault" | "kind"> & { kind: string; env: string; isDefault: number }>`
			SELECT id, kind, name, executable, home, args, env, is_default FROM servers ORDER BY pos
		`.pipe(
			Effect.flatMap((rows) =>
				Effect.forEach(rows, (row) =>
					decodeEnv(row.env).pipe(
						Effect.map((env): Row => ({ ...row, kind: "local", env, isDefault: row.isDefault === 1 })),
					),
				),
			),
			Effect.orDie,
		);

		const get = (id: string) =>
			list.pipe(
				Effect.map((rows) => rows.find((row) => row.id === id)),
				Effect.flatMap((row) => (row === undefined ? Effect.fail(fail(`No server ${id}`)) : Effect.succeed(row))),
			);

		const homeOf = (row: Row) => ({
			path: row.home ?? fallback,
			custom: row.home !== null,
			fallback: row.id === LOCAL_SERVER ? fallback : null,
		});

		const defaultHome = list.pipe(Effect.map((rows) => homeOf(rows.find((row) => row.isDefault) ?? rows[0]!).path));
		const current = yield* SubscriptionRef.make(yield* defaultHome);
		// Told after every write, so a new default or a new home for it reaches the connection.
		const announce = defaultHome.pipe(
			Effect.flatMap((home) =>
				SubscriptionRef.get(current).pipe(
					Effect.flatMap((was) => (was === home ? Effect.void : SubscriptionRef.set(current, home))),
				),
			),
		);

		// A home names one server, so no two servers share one.
		const ensureOwnHome = (id: string | null, home: string) =>
			list.pipe(
				Effect.flatMap((rows) => {
					const taken = rows.find((row) => row.id !== id && homeOf(row).path === home);
					return taken === undefined
						? Effect.void
						: Effect.fail(fail(`${taken.name} already uses ${home}; each server needs its own home.`));
				}),
			);

		const name = (input: string) => {
			const trimmed = input.trim();
			return trimmed === "" ? Effect.fail(fail("A server needs a name.")) : Effect.succeed(trimmed);
		};

		const transaction = <A, E>(effect: Effect.Effect<A, E>) =>
			sql.withTransaction(effect).pipe(Effect.catchTag("SqlError", Effect.die));

		return Service.of({
			list,
			get,
			homeOf,
			defaultHome,
			homeChanges: SubscriptionRef.changes(current).pipe(Stream.drop(1)),

			add: Effect.fn("Servers.add")(function* (input) {
				const home = yield* chosenPath(input.home);
				if (home === null) return yield* fail("A new server needs a home of its own.");
				const id = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8));
				yield* transaction(
					Effect.gen(function* () {
						yield* ensureOwnHome(null, home);
						const [last] = yield* sql<{ pos: number }>`SELECT COALESCE(MAX(pos), 0) AS pos FROM servers`;
						yield* sql`INSERT INTO servers ${sql.insert({
							id,
							kind: "local",
							name: yield* name(input.name),
							executable: yield* chosenCommand(fs, input.executable),
							home,
							args: input.args.trim(),
							env: "[]",
							isDefault: 0,
							pos: (last?.pos ?? 0) + 1,
							created: yield* Clock.currentTimeMillis,
						})}`;
					}),
				);
				return id;
			}),

			update: Effect.fn("Servers.update")(function* ({ id, ...patch }) {
				yield* transaction(
					Effect.gen(function* () {
						const row = yield* get(id);
						const fields: Record<string, string | null> = {};
						if (patch.name !== undefined) fields.name = yield* name(patch.name);
						if (patch.executable !== undefined) fields.executable = yield* chosenCommand(fs, patch.executable);
						if (patch.args !== undefined) fields.args = patch.args.trim();
						if (patch.env !== undefined) fields.env = JSON.stringify(yield* nextEnv(patch.env, row.env));
						if (patch.home !== undefined) {
							const home = yield* chosenPath(patch.home);
							if (home === null && row.id !== LOCAL_SERVER)
								return yield* fail("An added server keeps a home of its own.");
							yield* ensureOwnHome(id, home ?? fallback);
							fields.home = home;
						}
						if (Object.keys(fields).length > 0)
							yield* sql`UPDATE servers SET ${sql.update(fields)} WHERE id = ${id}`;
					}),
				);
				yield* announce;
			}),

			remove: Effect.fn("Servers.remove")(function* (id) {
				const row = yield* get(id);
				if (row.id === LOCAL_SERVER) return yield* fail("The built-in local server cannot be removed.");
				if (row.isDefault) return yield* fail("Make another server the default before removing this one.");
				yield* sql`DELETE FROM servers WHERE id = ${id}`.pipe(Effect.orDie);
			}),

			setDefault: Effect.fn("Servers.setDefault")(function* (id) {
				yield* transaction(
					Effect.gen(function* () {
						yield* get(id);
						yield* sql`UPDATE servers SET is_default = CASE WHEN id = ${id} THEN 1 ELSE 0 END`;
					}),
				);
				yield* announce;
			}),
		});
	}),
);

export * as Servers from "./servers.ts";
