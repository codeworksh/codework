import { Clock, Config, Context, Effect, FileSystem, Layer, Schema, Stream, SubscriptionRef } from "effect";
import { SqlClient } from "effect/sql";
/* @effect-diagnostics nodeBuiltinImport:off -- paths typed in Settings expand against the OS home directory. */
import os from "node:os";
import path from "node:path";
import { type CliEnvVar, LOCAL_SERVER, type ServerAdd, ServersError, type ServerUpdate } from "@codeworksh/contract";

/** The same home the CLI resolves: CODEWORK_HOME_DIR, else ~/.codework. Only the built-in server falls back to it. */
export const cliHome = Config.String("CODEWORK_HOME_DIR").pipe(
	Config.withDefault(path.join(os.homedir(), ".codework")),
);

// Stored with every value; only the app server reads the sensitive ones.
export const StoredEnv = Schema.Array(
	Schema.Struct({ name: Schema.String, value: Schema.String, sensitive: Schema.Boolean }),
);
export type StoredEnv = typeof StoredEnv.Type;

/** Splits typed arguments as a shell would for plain words and quotes: `--name "a b"` is two. */
export const splitArgs = (input: string) =>
	[...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");

/**
 * What a machine is called: the user's override, else the name its server reports, else where it is.
 * The one rule every machine name shown goes through.
 */
export const nameOf = (machine: {
	readonly kind: string;
	readonly override: string | null;
	readonly host: string | null;
	readonly url: string | null;
}) =>
	machine.override ??
	machine.host ??
	(machine.kind === "remote" && machine.url !== null && URL.canParse(machine.url)
		? new URL(machine.url).host
		: "This Machine");

/** How a machine is named, as stored and as shown. */
interface Naming {
	/** As shown: {@link nameOf}. */
	readonly name: string;
	/** As its server last reported it. */
	readonly host: string | null;
	/** As the user named it in Settings. */
	readonly override: string | null;
}

/** A local server as stored. A `null` executable or home is the one found. An executable is a path, or a
 * command whose first word is one (`node --conditions=development …/index.ts`, running from source). */
export interface LocalRow extends Naming {
	readonly id: string;
	readonly kind: "local";
	readonly executable: string | null;
	readonly home: string | null;
	readonly args: string;
	readonly env: StoredEnv;
	readonly isDefault: boolean;
}

/** A remote server as stored: where the app reaches it. */
export interface RemoteRow extends Naming {
	readonly id: string;
	readonly kind: "remote";
	readonly url: string;
	readonly isDefault: boolean;
}

export type Row = LocalRow | RemoteRow;

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

/** A remote server's URL typed in Settings: CodeWork answers over a WebSocket. */
const chosenUrl = (input: string) => {
	const trimmed = input.trim();
	return URL.canParse(trimmed) && ["ws:", "wss:"].includes(new URL(trimmed).protocol)
		? Effect.succeed(trimmed)
		: Effect.fail(fail("Use a WebSocket URL, such as wss://codework.example.com/rpc."));
};

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
 * names the server. The built-in local server is always there. The default is always a local one:
 * the connection finds its server through a home.
 */
export class Service extends Context.Service<
	Service,
	{
		readonly list: Effect.Effect<ReadonlyArray<Row>>;
		readonly get: (id: string) => Effect.Effect<Row, ServersError>;
		/** The local server `id`; a remote one is refused. */
		readonly getLocal: (id: string) => Effect.Effect<LocalRow, ServersError>;
		/** The home a local server uses; `fallback` is the built-in server's when none is chosen. */
		readonly homeOf: (row: LocalRow) => {
			readonly path: string;
			readonly custom: boolean;
			readonly fallback: string | null;
		};
		/** The default server's home. */
		readonly defaultHome: Effect.Effect<string>;
		/** The default server's home each time it changes, without the current one. */
		readonly homeChanges: Stream.Stream<string>;
		/** Every server now, then again after each change to any of them. */
		readonly watch: Stream.Stream<ReadonlyArray<Row>>;
		/** Stores the name a server reports, when it is not the one stored. */
		readonly setHost: (id: string, host: string | null) => Effect.Effect<void>;
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

		const list = sql<
			Omit<LocalRow, "kind" | "env" | "isDefault" | "name"> & {
				kind: string;
				env: string;
				url: string | null;
				isDefault: number;
			}
		>`
			SELECT id, kind, name AS override, host, executable, home, args, env, url, is_default FROM machine ORDER BY pos
		`.pipe(
			Effect.flatMap((rows) =>
				Effect.forEach(rows, ({ kind, url, env, isDefault, ...row }) => {
					const naming = { name: nameOf({ kind, url, ...row }), host: row.host, override: row.override };
					return kind === "remote" && url !== null
						? Effect.succeed<Row>({ id: row.id, kind, ...naming, url, isDefault: isDefault === 1 })
						: decodeEnv(env).pipe(
								Effect.map((env): Row => ({
									...row,
									...naming,
									kind: "local",
									env,
									isDefault: isDefault === 1,
								})),
							);
				}),
			),
			Effect.orDie,
		);
		const locals = list.pipe(Effect.map((rows) => rows.filter((row): row is LocalRow => row.kind === "local")));

		const get = (id: string) =>
			list.pipe(
				Effect.map((rows) => rows.find((row) => row.id === id)),
				Effect.flatMap((row) => (row === undefined ? Effect.fail(fail(`No server ${id}`)) : Effect.succeed(row))),
			);

		const getLocal = (id: string) =>
			get(id).pipe(
				Effect.flatMap((row) =>
					row.kind === "local" ? Effect.succeed(row) : Effect.fail(fail(`${row.name} is a remote server.`)),
				),
			);

		const homeOf = (row: LocalRow) => ({
			path: row.home ?? fallback,
			custom: row.home !== null,
			fallback: row.id === LOCAL_SERVER ? fallback : null,
		});

		const defaultHome = locals.pipe(Effect.map((rows) => homeOf(rows.find((row) => row.isDefault) ?? rows[0]!).path));
		const current = yield* SubscriptionRef.make(yield* defaultHome);
		const machines = yield* SubscriptionRef.make(yield* list);
		// Told after every write, so a new default or a new home for it reaches the connection, and
		// every change of a server reaches the sync.
		const announce = defaultHome.pipe(
			Effect.flatMap((home) =>
				SubscriptionRef.get(current).pipe(
					Effect.flatMap((was) => (was === home ? Effect.void : SubscriptionRef.set(current, home))),
				),
			),
			Effect.andThen(list),
			Effect.flatMap((rows) => SubscriptionRef.set(machines, rows)),
		);

		// A home names one server, so no two servers share one.
		const ensureOwnHome = (id: string | null, home: string) =>
			locals.pipe(
				Effect.flatMap((rows) => {
					const taken = rows.find((row) => row.id !== id && homeOf(row).path === home);
					return taken === undefined
						? Effect.void
						: Effect.fail(fail(`${taken.name} already uses ${home}; each server needs its own home.`));
				}),
			);

		/** A name typed in Settings; blank is no override. */
		const override = (input: string | undefined) => {
			const trimmed = input?.trim() ?? "";
			return trimmed === "" ? null : trimmed;
		};

		const transaction = <A, E>(effect: Effect.Effect<A, E>) =>
			sql.withTransaction(effect).pipe(Effect.catchTag("SqlError", Effect.die));

		return Service.of({
			list,
			get,
			getLocal,
			homeOf,
			defaultHome,
			homeChanges: SubscriptionRef.changes(current).pipe(Stream.drop(1)),
			watch: SubscriptionRef.changes(machines),
			setHost: Effect.fn("Servers.setHost")(function* (id, host) {
				const changed = yield* sql`
					UPDATE machine SET host = ${host} WHERE id = ${id} AND host IS NOT ${host} RETURNING id
				`.pipe(Effect.orDie);
				if (changed.length > 0) yield* announce;
			}),

			add: Effect.fn("Servers.add")(function* (input) {
				const id = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8));
				const home = input.kind === "local" ? yield* chosenPath(input.home) : null;
				if (input.kind === "local" && home === null) return yield* fail("A new server needs a home of its own.");
				const route =
					input.kind === "local"
						? { executable: yield* chosenCommand(fs, input.executable), home, args: input.args.trim() }
						: { url: yield* chosenUrl(input.url) };
				yield* transaction(
					Effect.gen(function* () {
						if (home !== null) yield* ensureOwnHome(null, home);
						const [last] = yield* sql<{ pos: number }>`SELECT COALESCE(MAX(pos), 0) AS pos FROM machine`;
						yield* sql`INSERT INTO machine ${sql.insert({
							id,
							kind: input.kind,
							name: override(input.name),
							...route,
							namespace: "codework",
							pos: (last?.pos ?? 0) + 1,
							createdAt: yield* Clock.currentTimeMillis,
						})}`;
					}),
				);
				yield* announce;
				return id;
			}),

			update: Effect.fn("Servers.update")(function* ({ id, ...patch }) {
				yield* transaction(
					Effect.gen(function* () {
						const row = yield* get(id);
						const fields: Record<string, string | null> = {};
						if (patch.name !== undefined) fields.name = override(patch.name);
						if (row.kind === "remote") {
							if ([patch.executable, patch.home, patch.args, patch.env].some((value) => value !== undefined))
								return yield* fail("A remote server has no executable, home, arguments or variables.");
							if (patch.url !== undefined) fields.url = yield* chosenUrl(patch.url);
						} else {
							if (patch.url !== undefined) return yield* fail("Only a remote server has a URL.");
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
						}
						if (Object.keys(fields).length > 0)
							yield* sql`UPDATE machine SET ${sql.update(fields)} WHERE id = ${id}`;
					}),
				);
				yield* announce;
			}),

			// What was synced from the server goes with it, its rows cascading, except its usage: history.
			remove: Effect.fn("Servers.remove")(function* (id) {
				const row = yield* get(id);
				if (row.id === LOCAL_SERVER) return yield* fail("The built-in local server cannot be removed.");
				if (row.isDefault) return yield* fail("Make another server the default before removing this one.");
				yield* sql`DELETE FROM machine WHERE id = ${id}`.pipe(Effect.orDie);
				yield* announce;
			}),

			setDefault: Effect.fn("Servers.setDefault")(function* (id) {
				yield* transaction(
					Effect.gen(function* () {
						yield* getLocal(id);
						yield* sql`UPDATE machine SET is_default = CASE WHEN id = ${id} THEN 1 ELSE 0 END`;
					}),
				);
				yield* announce;
			}),
		});
	}),
);

export * as Servers from "./servers.ts";
