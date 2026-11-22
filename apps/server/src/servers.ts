import {
	Clock,
	Config,
	Context,
	Effect,
	Equal,
	FileSystem,
	Layer,
	Option,
	Schema,
	Stream,
	SubscriptionRef,
} from "effect";
import { SqlClient } from "effect/sql";
/* @effect-diagnostics nodeBuiltinImport:off -- paths typed in Settings expand against the OS home directory. */
import os from "node:os";
import path from "node:path";
import {
	type CliEnvVar,
	LOCAL_SERVER,
	type Mismatch,
	PairingRefused,
	RemoteServerStatus,
	type ServerAdd,
	ServersError,
	type ServerUpdate,
} from "@codeworksh/contract";
import { Jws, type Machine } from "@codeworksh/schema";
import { Pairing } from "./pairing.ts";

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
 * What a machine is called: the user's override of a local one, else the label stored on a remote one,
 * else the name its server reports, else where it is. The one rule every machine name shown goes through.
 */
export const nameOf = (machine: {
	readonly kind: string;
	readonly override: string | null;
	readonly label: string | null;
	readonly host: string | null;
	readonly url: string | null;
}) =>
	machine.override ??
	machine.label ??
	machine.host ??
	(machine.kind === "remote" && machine.url !== null && URL.canParse(machine.url)
		? new URL(machine.url).host
		: "This Machine");

/** A local server as stored. A `null` executable or home is the one found. An executable is a path, or a
 * command whose first word is one (`node --conditions=development …/index.ts`, running from source). */
export interface LocalRow {
	readonly id: string;
	/** As shown: {@link nameOf}. */
	readonly name: string;
	/** As its server last reported it. */
	readonly host: string | null;
	/** As the user named it in Settings. */
	readonly override: string | null;
	readonly kind: "local";
	readonly executable: string | null;
	readonly home: string | null;
	readonly args: string;
	readonly env: StoredEnv;
	readonly isDefault: boolean;
}

/** A remote server as stored: where the app reaches it, how it paired, and what it last reported. */
export interface RemoteRow {
	readonly id: string;
	readonly kind: "remote";
	/** As shown: {@link nameOf}. */
	readonly name: string;
	readonly host: string | null;
	/** The label stored on the machine. */
	readonly label: string | null;
	readonly version: string | null;
	readonly seenAt: number | null;
	/** Whether its sync connection is up now. */
	readonly online: boolean;
	/** The machine's own id, as it last reported it. */
	readonly machineId: string | null;
	/** The workspaces it is linked to, as it last reported them. */
	readonly workspaces: RemoteServerStatus["workspaces"];
	readonly url: string;
	/** The id the machine gave this app's key; none once the machine refused it, or on a row from before keys. */
	readonly device: string | null;
	/** The machine's identity key, as it paired: every ticket it grants is signed with it. */
	readonly machineKey: Jws.PublicKey | null;
	/** What last kept it from connecting while paired, until it connects. */
	readonly mismatch: Mismatch | null;
	readonly isDefault: boolean;
}

export type Row = LocalRow | RemoteRow;

/** What a server reports about itself; an absent one is left as stored. */
export interface Facts {
	readonly host?: string | null;
	readonly label?: string | null;
	readonly version?: string;
	readonly machineId?: string | null;
	readonly workspaces?: RemoteServerStatus["workspaces"];
}

/** What a remote machine's own record says about it: its label, its id and its links. */
export const factsOf = (status: Machine.Status): Facts => ({
	label: status.givenName,
	machineId: status.id,
	workspaces: status.workspaces.map(({ id, keyId }) => ({ id, keyId })),
});

const Workspaces = Schema.fromJsonString(RemoteServerStatus.fields.workspaces);
const decodeWorkspaces = Schema.decodeUnknownOption(Workspaces);
const encodeWorkspaces = Schema.encodeSync(Workspaces);

const decodeEnv = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredEnv));

const MachineKey = Schema.fromJsonString(Jws.PublicKey);
const decodeMachineKey = Schema.decodeUnknownOption(MachineKey);
const encodeMachineKey = Schema.encodeSync(MachineKey);
const DeviceKey = Schema.fromJsonString(Jws.PrivateKey);

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
		/** Stores what a server answered and when, and counts it online until {@link lost}. */
		readonly reached: (id: string, facts: Facts) => Effect.Effect<void>;
		/** Counts a server offline once its connection is gone; it was answering until then. */
		readonly lost: (id: string) => Effect.Effect<void>;
		/** Records what kept a remote server from connecting while paired, or none once it connects. */
		readonly answered: (id: string, mismatch: Mismatch | null) => Effect.Effect<void>;
		/** Forgets a remote server's link to a workspace that was removed at the relay, without it. */
		readonly unlinked: (id: string, workspaceId: string) => Effect.Effect<void, ServersError>;
		readonly add: (input: ServerAdd) => Effect.Effect<string, ServersError | PairingRefused>;
		readonly update: (input: ServerUpdate) => Effect.Effect<void, ServersError | PairingRefused>;
		/** Drops a remote server's pairing once the server refused it, unless the row paired again since. */
		readonly unpair: (id: string, device: string) => Effect.Effect<void>;
		/** This app's own key, the one every remote server pairs. */
		readonly deviceKey: Jws.PrivateKey;
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

		// Ids whose sync connection is up, and what kept the others from connecting: known only while this
		// process runs.
		const online = new Set<string>();
		const mismatches = new Map<string, Mismatch>();

		// Made on the first start; one per install.
		const [storedKey] = yield* sql<{ key: string }>`SELECT key FROM device`.pipe(Effect.orDie);
		const deviceKey =
			storedKey === undefined
				? yield* Effect.gen(function* () {
						const key = yield* Jws.generate();
						yield* sql`INSERT INTO device ${sql.insert({ key: yield* Schema.encodeEffect(DeviceKey)(key) })}`;
						return key;
					}).pipe(Effect.orDie)
				: yield* Schema.decodeEffect(DeviceKey)(storedKey.key).pipe(Effect.orDie);

		const list = sql<
			Omit<LocalRow, "kind" | "env" | "isDefault" | "name"> & {
				kind: string;
				env: string;
				url: string | null;
				device: string | null;
				machineKey: string | null;
				label: string | null;
				version: string | null;
				seenAt: number | null;
				identity: string | null;
				workspaces: string | null;
				isDefault: number;
			}
		>`
			SELECT id, kind, name AS override, host, label, version, seen_at, identity, workspaces, executable, home, args,
				env, url, device, machine_key, is_default
			FROM machine ORDER BY pos
		`.pipe(
			Effect.flatMap((rows) =>
				Effect.forEach(
					rows,
					({
						kind,
						url,
						device,
						machineKey,
						env,
						isDefault,
						label,
						version,
						seenAt,
						identity,
						workspaces,
						...row
					}) => {
						const name = nameOf({ kind, url, label, ...row });
						return kind === "remote" && url !== null
							? Effect.succeed<Row>({
									id: row.id,
									kind,
									name,
									host: row.host,
									label,
									version,
									seenAt,
									online: online.has(row.id),
									machineId: identity,
									workspaces: Option.getOrElse(decodeWorkspaces(workspaces), () => []),
									url,
									device,
									machineKey: Option.getOrNull(decodeMachineKey(machineKey)),
									mismatch: mismatches.get(row.id) ?? null,
									isDefault: isDefault === 1,
								})
							: decodeEnv(env).pipe(
									Effect.map((env): Row => ({
										...row,
										name,
										kind: "local",
										env,
										isDefault: isDefault === 1,
									})),
								);
					},
				),
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

		/** This app's key paired on the remote server at `url` for the code typed in Settings, named after this computer. */
		const pair = (url: string, code: string) =>
			Effect.gen(function* () {
				const label = ((yield* list).find((row) => row.id === LOCAL_SERVER)?.host ?? os.hostname()).slice(0, 100);
				const device = yield* Pairing.exchange(url, code.trim(), label, deviceKey).pipe(
					Effect.timeout("10 seconds"),
					Effect.mapError(() => fail("No Machine answered at that address. Check it, then try again.")),
				);
				if (device === undefined)
					return yield* new PairingRefused({
						message:
							"That pairing code was not accepted. Run codework service pair on the machine for a new one.",
					});
				return { device: device.id, machineKey: encodeMachineKey(device.machine) };
			});

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
			reached: Effect.fn("Servers.reached")(function* (id, { machineId, workspaces, ...facts }) {
				const seenAt = yield* Clock.currentTimeMillis;
				const fields = {
					...facts,
					...(machineId === undefined ? {} : { identity: machineId }),
					...(workspaces === undefined ? {} : { workspaces: encodeWorkspaces(workspaces) }),
					seenAt,
				};
				yield* sql`UPDATE machine SET ${sql.update(fields)} WHERE id = ${id}`.pipe(Effect.orDie);
				online.add(id);
				yield* announce;
			}),

			lost: Effect.fn("Servers.lost")(function* (id) {
				if (!online.delete(id)) return;
				const seenAt = yield* Clock.currentTimeMillis;
				yield* sql`UPDATE machine SET seen_at = ${seenAt} WHERE id = ${id}`.pipe(Effect.orDie);
				yield* announce;
			}),

			unlinked: Effect.fn("Servers.unlinked")(function* (id, workspaceId) {
				const row = yield* get(id);
				if (row.kind !== "remote") return yield* fail("Only a paired Machine has links of its own.");
				const workspaces = row.workspaces.filter((link) => link.id !== workspaceId);
				yield* sql`UPDATE machine SET workspaces = ${encodeWorkspaces(workspaces)} WHERE id = ${id}`.pipe(
					Effect.orDie,
				);
				yield* announce;
			}),

			add: Effect.fn("Servers.add")(function* (input) {
				const id = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8));
				const home = input.kind === "local" ? yield* chosenPath(input.home) : null;
				if (input.kind === "local" && home === null) return yield* fail("A new server needs a home of its own.");
				const route =
					input.kind === "local"
						? { executable: yield* chosenCommand(fs, input.executable), home, args: input.args.trim() }
						: yield* Effect.gen(function* () {
								const url = yield* chosenUrl(input.url);
								return { url, ...(yield* pair(url, input.code)) };
							});
				yield* transaction(
					Effect.gen(function* () {
						if (home !== null) yield* ensureOwnHome(null, home);
						const [last] = yield* sql<{ pos: number }>`SELECT COALESCE(MAX(pos), 0) AS pos FROM machine`;
						yield* sql`INSERT INTO machine ${sql.insert({
							id,
							kind: input.kind,
							name: input.kind === "local" ? override(input.name) : null,
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
				// Paired before the transaction, which would otherwise hold the database through a network call.
				const { code } = patch;
				const pairing =
					code === undefined
						? undefined
						: yield* get(id).pipe(
								Effect.flatMap((row) =>
									row.kind === "remote"
										? Effect.flatMap(
												patch.url === undefined ? Effect.succeed(row.url) : chosenUrl(patch.url),
												(url) => pair(url, code),
											)
										: Effect.fail(fail("Only a remote server has a pairing code.")),
								),
							);
				yield* transaction(
					Effect.gen(function* () {
						const row = yield* get(id);
						const fields: Record<string, string | null> = {};
						if (row.kind === "remote") {
							if (patch.name !== undefined) return yield* fail("A paired Machine is renamed with its Label.");
							if ([patch.executable, patch.home, patch.args, patch.env].some((value) => value !== undefined))
								return yield* fail("A remote server has no executable, home, arguments or variables.");
							if (patch.url !== undefined) fields.url = yield* chosenUrl(patch.url);
							if (pairing !== undefined) Object.assign(fields, pairing);
						} else {
							if (patch.name !== undefined) fields.name = override(patch.name);
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
				if (pairing !== undefined) mismatches.delete(id);
				yield* announce;
			}),

			answered: Effect.fn("Servers.answered")(function* (id, mismatch) {
				if (Equal.equals(mismatches.get(id) ?? null, mismatch)) return;
				if (mismatch === null) mismatches.delete(id);
				else mismatches.set(id, mismatch);
				yield* announce;
			}),

			unpair: Effect.fn("Servers.unpair")(function* (id, device) {
				const changed = yield* sql`
					UPDATE machine SET device = NULL WHERE id = ${id} AND device = ${device} RETURNING id
				`.pipe(Effect.orDie);
				if (changed.length > 0) yield* announce;
			}),

			deviceKey,

			// What was synced from the server goes with it, its rows cascading, except its usage: history.
			remove: Effect.fn("Servers.remove")(function* (id) {
				const row = yield* get(id);
				if (row.id === LOCAL_SERVER) return yield* fail("The built-in local server cannot be removed.");
				if (row.isDefault) return yield* fail("Make another server the default before removing this one.");
				yield* sql`DELETE FROM machine WHERE id = ${id}`.pipe(Effect.orDie);
				mismatches.delete(id);
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
