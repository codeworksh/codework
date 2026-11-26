/* @effect-diagnostics nodeBuiltinImport:off -- the E2E suites spawn the real app server and CodeWork servers in temp dirs. */
import { Effect, Layer, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect } from "vite-plus/test";
import { Contract, type RemoteServerStatus, type ServerStatus } from "@codeworksh/contract";
import { Door } from "@codeworksh/schema";
import * as Client from "../../../../packages/codework/src/server/client.ts";

const appEntry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./codework.ts", import.meta.url));

export type Row = Record<string, unknown>;

// Every process and directory a case made, cleaned up whether it passed or not.
const processes = new Set<ChildProcess>();
const dirs = new Set<string>();

/** Stops every process and removes every directory a case made; run it after each case. */
export const cleanup = async () => {
	await Promise.all([...processes].map((proc) => stop(proc)));
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.clear();
};

export const tempDir = (name: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `codework-${name}-`)));
	dirs.add(dir);
	return dir;
};

export const freePort = () =>
	new Promise<number>((resolve) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});

/** What the app server's ready line says: its port and the token its door takes. */
export interface Ready {
	readonly port: number;
	readonly token: string;
}

/** Resolves with the first stdout line that is a JSON `ready` message. */
export const ready = <A = Ready>(proc: ChildProcess) =>
	new Promise<A>((resolve, reject) => {
		proc.once("exit", (code) => reject(new Error(`exited before ready (code ${code})`)));
		createInterface({ input: proc.stdout! }).on("line", (line) => {
			if (line.startsWith('{"type":"ready"')) resolve(JSON.parse(line) as A);
		});
	});

/** A connection to the app server, opened as the desktop app's page opens it but with no `Origin`. */
export const appProtocol = ({ port, token }: Ready) =>
	RpcClient.layerProtocolSocket().pipe(
		Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`, { protocols: Door.protocols(token) })),
		Layer.provide(Socket.layerWebSocketConstructorGlobal),
		Layer.provide(RpcSerialization.layerNdjson),
	);

export async function stop(proc: ChildProcess, signal: NodeJS.Signals = "SIGKILL") {
	processes.delete(proc);
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	const exited = new Promise((resolve) => proc.once("exit", resolve));
	proc.kill(signal);
	await exited;
}

export const waitFor = async <A>(
	read: () => A | undefined | Promise<A | undefined>,
	what: string,
	timeout = 20_000,
) => {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		const value = await read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`timed out waiting for ${what}`);
};

/**
 * A CodeWork server of the fixture in `home` on `port`, with its scripted model; `older` lacks
 * `usage.sync` and a host name. `host` is the host name it reports (`null` for none), else `Fixture`.
 * `relay` is where its connects go (`CODEWORK_RELAY_URL`). `skew` runs its clock that many milliseconds off.
 */
export const codework = async (
	home: string,
	port: number,
	options: {
		readonly older?: boolean;
		readonly host?: string | null;
		readonly relay?: string;
		readonly skew?: number;
		/** The OS home its `~` and host folders resolve against; the test runner's when omitted. */
		readonly osHome?: string;
	} = {},
) => {
	const args = [fixture, home, String(port), ...(options.older === true ? ["127.0.0.1", "older"] : [])];
	const proc = spawn(process.execPath, ["--conditions=development", ...args], {
		env: {
			...process.env,
			...(options.host === undefined ? {} : { CODEWORK_FIXTURE_HOST: options.host ?? "" }),
			...(options.relay === undefined ? {} : { CODEWORK_RELAY_URL: options.relay }),
			...(options.skew === undefined ? {} : { CODEWORK_FIXTURE_SKEW: String(options.skew) }),
			...(options.osHome === undefined ? {} : { HOME: options.osHome }),
		},
		stdio: ["pipe", "pipe", "inherit"],
	});
	processes.add(proc);
	await ready<object>(proc);
	const url = `ws://127.0.0.1:${port}/rpc/v1`;
	// Registered before it reports ready; a call from this computer takes the token.
	const { token } = JSON.parse(readFileSync(join(home, "service.json"), "utf8")) as { token: string };
	const run = <A, E>(use: (rpc: Client.Client) => Effect.Effect<A, E>) =>
		Effect.gen(function* () {
			return yield* use(yield* Client.make);
		}).pipe(Effect.scoped, Effect.provide(Client.layer({ url, token })), Effect.runPromise);
	return {
		url,
		token,
		proc,
		database: join(home, "data", "codework.db"),
		/** The oldest held reply takes its next step. */
		release: () => proc.stdin!.write("release\n"),
		run,
		/** A fresh pairing code, as `codework service pair` prints it. */
		pair: () => run((rpc) => rpc["device.pair"]({})).then(({ code }) => code),
		/** The fingerprint of its machine key, as `codework service pair` prints it. */
		fingerprint: () => run((rpc) => rpc["device.pair"]({})).then(({ fingerprint }) => fingerprint),
	};
};
export type Codework = Awaited<ReturnType<typeof codework>>;

/**
 * A status as an artifact keeps it: a remote one's build, last answer, machine id and key vary per run.
 * Its round trip is left out: it is timed after each check, so whether one is in yet varies too.
 */
export const stable = (status: ServerStatus | undefined) => {
	if (status === undefined) return undefined;
	const { rtt: _, ...rest } = status;
	return rest.kind === "remote"
		? {
				...rest,
				version: rest.version === null ? null : "<version>",
				seenAt: rest.seenAt === null ? null : "<time>",
				fingerprint: rest.fingerprint === null ? null : "<fingerprint>",
				machineId: rest.machineId === null ? null : "<machine id>",
			}
		: rest;
};

const appClient = RpcClient.make(Contract.Api);
export type AppRpc = Effect.Success<typeof appClient>;

/** The app server with its database in `home`; its own CLI home names no CodeWork server. */
export const app = async (home: string) => {
	const proc = spawn(process.execPath, [appEntry], {
		env: { ...process.env, CODEWORK_DATABASE: join(home, "app.db"), CODEWORK_HOME_DIR: join(home, "cli") },
		stdio: ["ignore", "pipe", "inherit"],
	});
	processes.add(proc);
	// Its stdout, the log included, line by line.
	const lines: Array<string> = [];
	createInterface({ input: proc.stdout! }).on("line", (line) => lines.push(line));
	const started = await ready(proc);
	const protocol = appProtocol(started);
	return {
		...started,
		proc,
		lines,
		run: <A, E>(use: (rpc: AppRpc) => Effect.Effect<A, E>) =>
			Effect.gen(function* () {
				return yield* use(yield* appClient);
			}).pipe(Effect.scoped, Effect.provide(protocol), Effect.runPromise),
		/** Runs `use` in the background on a connection of its own until `stop` is called. */
		background: <A, E>(use: (rpc: AppRpc) => Effect.Effect<A, E>) => {
			const controller = new AbortController();
			const done = Effect.gen(function* () {
				return yield* use(yield* appClient);
			}).pipe(Effect.scoped, Effect.provide(protocol), (effect) =>
				Effect.runPromise(effect, { signal: controller.signal }).catch(() => undefined),
			);
			return { stop: () => controller.abort(), done };
		},
	};
};

/** Statuses of `id` from `servers.watch`, waited for until one passes `test`. */
export const watchOf =
	(desk: Awaited<ReturnType<typeof app>>, id: string) =>
	(what: string, test: (status: RemoteServerStatus) => boolean) =>
		waitFor(async () => {
			const statuses = await desk.run((rpc) => rpc["servers.watch"](undefined).pipe(Stream.runHead));
			const found = statuses._tag === "Some" ? statuses.value.find((each) => each.id === id) : undefined;
			return found?.kind === "remote" && test(found) ? found : undefined;
		}, what);

/** Reads app.db while the app runs; each read opens the file afresh. */
export const query = (home: string, statement: string, ...params: Array<string | number | null>): Array<Row> => {
	const db = new DatabaseSync(join(home, "app.db"));
	try {
		return db.prepare(statement).all(...params) as Array<Row>;
	} finally {
		db.close();
	}
};
export const write = (home: string, statement: string, ...params: Array<string | number | null>) => {
	// Waits out the app's own writes, as a startup's.
	const db = new DatabaseSync(join(home, "app.db"), { timeout: 5_000 });
	try {
		db.prepare(statement).run(...params);
	} finally {
		db.close();
	}
};

/** The private part of the app's device key, which nothing it sends may contain. */
export const deviceSecret = (home: string) =>
	(JSON.parse(query(home, "SELECT key FROM device")[0]!.key as string) as { d: string }).d;

/** The id a remote machine gave the app's key; none once it is not paired. */
export const deviceOf = (home: string, id: string) =>
	query(home, "SELECT device FROM machine WHERE id = ?", id)[0]!.device as string | null;

export const machineRow = (home: string, id: string) =>
	query(home, "SELECT store_id, cursor FROM machine WHERE id = ?", id)[0] as {
		store_id: string | null;
		cursor: number;
	};

/** Adds the CodeWork server as a remote machine, paired with a fresh code, then waits until the app holds its head. */
export const addMachine = async (home: string, server: Codework, run: Awaited<ReturnType<typeof app>>["run"]) => {
	const code = await server.pair();
	const id = await run((rpc) => rpc["servers.add"]({ kind: "remote", url: server.url, code }));
	await synced(home, id, server);
	return id;
};

/** Waits until the app's cursor for `machineId` reached the server's head. */
export const synced = async (home: string, machineId: string, server: Codework) => {
	const { storeId, rev } = await server.run((rpc) => rpc["server.info"]({}));
	await waitFor(() => {
		const row = machineRow(home, machineId);
		return row?.store_id === storeId && row.cursor >= rev ? row : undefined;
	}, `machine ${machineId} at rev ${rev}`);
	return { storeId, rev };
};

export const cursorOf = (home: string, machineId: string) =>
	query(home, "SELECT rollup, rollup_store FROM machine WHERE id = ?", machineId)[0] as {
		rollup: number;
		rollup_store: string | null;
	};

/** Waits until the app's usage cursor for `machineId` reached the server's head. */
export const rolled = async (home: string, machineId: string, server: Codework) => {
	const { storeId, rev } = await server.run((rpc) => rpc["server.info"]({}));
	await waitFor(() => {
		const row = cursorOf(home, machineId);
		return row.rollup_store === storeId && row.rollup >= rev ? row : undefined;
	}, `usage of machine ${machineId} at rev ${rev}`);
	return { storeId, rev };
};

/** Events on `topics` from the moment it resolves (past `after` when given), collected until `stop`. */
export const follow = async (desk: Awaited<ReturnType<typeof app>>, topics: ReadonlyArray<string>, after?: number) => {
	const events: Array<{ topic: string; payload: Row }> = [];
	let subscribed = false;
	const background = desk.background((rpc) =>
		rpc["event.subscribe"]({ topics, ...(after === undefined ? {} : { after }) }).pipe(
			Stream.runForEach((item) =>
				Effect.sync(() => {
					if ("_tag" in item) subscribed = true;
					else events.push({ topic: item.topic, payload: item.payload as Row });
				}),
			),
		),
	);
	await waitFor(() => (subscribed ? true : undefined), `a subscription to ${topics.join(", ")}`);
	return { events, stop: background.stop };
};

/** The payloads of the sync's bus events after `after` (an event seq). */
export const notices = (home: string, topic: string, after = 0) =>
	query(home, "SELECT payload FROM event WHERE topic = ? AND seq > ? ORDER BY seq", topic, after).map(
		(row) => JSON.parse(row.payload as string) as Row,
	);
export const lastSeq = (home: string) =>
	(query(home, "SELECT COALESCE(MAX(seq), 0) AS seq FROM event")[0]!.seq as number) ?? 0;

// Ids by first appearance, seqs and revisions by rank, times and temp paths elided: what the
// artifact keeps is the shape and the relations, which are the contract.
const ID_COLUMNS = new Set([
	"id",
	"machine_id",
	"store_id",
	"project_id",
	"space_id",
	"session_id",
	"thread_id",
	"entry_id",
	"origin_thread_id",
	"origin_entry_id",
	"placement_space_id",
	"machineId",
	"threadId",
	"entryId",
	"sessionId",
	"spaceId",
	"grouping_id",
	"groupingId",
	"slug",
]);
const ID_LISTS = new Set(["project", "space", "session", "thread", "entry", "inbox", "removed", "entries", "threads"]);
const SEQ_KEYS = new Set(["seq", "floor", "created_seq", "origin_committed_seq", "admitted_seq"]);
const REV_KEYS = new Set(["cursor", "rev"]);

export const normalizer = (homes: ReadonlyArray<string>, fixed: ReadonlyArray<readonly [string, string]> = []) => {
	const labels = new Map<string, string>(fixed);
	const counts = new Map<string, number>();
	const label = (value: string) => {
		const known = labels.get(value);
		if (known !== undefined) return known;
		const kind = /^([a-z]+)_/.exec(value)?.[1] ?? "id";
		const count = (counts.get(kind) ?? 0) + 1;
		counts.set(kind, count);
		const made = `<${kind} ${count}>`;
		labels.set(value, made);
		return made;
	};
	return (artifact: unknown) => {
		const numbers = (keys: ReadonlySet<string>) => {
			const found = new Set<number>();
			const walk = (value: unknown, key?: string) => {
				if (typeof value === "number" && key !== undefined && keys.has(key)) found.add(value);
				else if (Array.isArray(value)) value.forEach((item) => walk(item));
				else if (typeof value === "object" && value !== null)
					for (const [k, v] of Object.entries(value)) walk(v, k);
			};
			walk(artifact);
			return [...found].sort((a, b) => a - b);
		};
		const seqs = numbers(SEQ_KEYS);
		const revs = numbers(REV_KEYS);
		const walk = (value: unknown, key?: string): unknown => {
			if (typeof value === "string") {
				if (key !== undefined && (ID_COLUMNS.has(key) || ID_LISTS.has(key))) return label(value);
				// Fixed labels are also replaced inside text, such as an error message naming an id.
				const text = homes.reduce((text, home) => text.split(home).join("<home>"), value);
				return fixed.reduce((text, [raw, made]) => text.split(raw).join(made), text);
			}
			if (typeof value === "number" && key !== undefined) {
				if (key.endsWith("_at") || key === "at") return "<time>";
				if (SEQ_KEYS.has(key)) return `<seq ${seqs.indexOf(value)}>`;
				if (REV_KEYS.has(key)) return `<rev ${revs.indexOf(value)}>`;
				return value;
			}
			if (Array.isArray(value))
				return value.map((item) => walk(item, key !== undefined && ID_LISTS.has(key) ? key : undefined));
			if (typeof value === "object" && value !== null)
				return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
			return value;
		};
		return walk(artifact);
	};
};

/** Matches `artifact` against `__artifacts__/<name>.json` beside the calling test file. */
export const snapshot = async (name: string, artifact: unknown) =>
	expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot(`./__artifacts__/${name}.json`);
