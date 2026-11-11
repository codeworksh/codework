/* @effect-diagnostics nodeBuiltinImport:off -- the E2E suites spawn the real app server and CodeWork servers in temp dirs. */
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect } from "vite-plus/test";
import { Contract } from "@codeworksh/contract";
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

/** Resolves with the first stdout line that is a JSON `ready` message. */
const ready = (proc: ChildProcess) =>
	new Promise<{ port?: number }>((resolve, reject) => {
		proc.once("exit", (code) => reject(new Error(`exited before ready (code ${code})`)));
		createInterface({ input: proc.stdout! }).on("line", (line) => {
			if (line.startsWith('{"type":"ready"')) resolve(JSON.parse(line) as { port?: number });
		});
	});

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

/** A CodeWork server of the fixture in `home` on `port`, with its scripted model. */
export const codework = async (home: string, port: number) => {
	const proc = spawn(process.execPath, ["--conditions=development", fixture, home, String(port)], {
		stdio: ["pipe", "pipe", "inherit"],
	});
	processes.add(proc);
	await ready(proc);
	const url = `ws://127.0.0.1:${port}/rpc/v1`;
	return {
		url,
		proc,
		database: join(home, "data", "codework.db"),
		/** The oldest held reply takes its next step. */
		release: () => proc.stdin!.write("release\n"),
		run: <A, E>(use: (rpc: Client.Client) => Effect.Effect<A, E>) =>
			Effect.gen(function* () {
				return yield* use(yield* Client.make);
			}).pipe(Effect.scoped, Effect.provide(Client.layer(url)), Effect.runPromise),
	};
};
export type Codework = Awaited<ReturnType<typeof codework>>;

const appClient = RpcClient.make(Contract.Api);
export type AppRpc = Effect.Success<typeof appClient>;

/** The app server with its database in `home`; its own CLI home names no CodeWork server. */
export const app = async (home: string) => {
	const proc = spawn(process.execPath, [appEntry], {
		env: { ...process.env, CODEWORK_DATABASE: join(home, "app.db"), CODEWORK_HOME_DIR: join(home, "cli") },
		stdio: ["ignore", "pipe", "inherit"],
	});
	processes.add(proc);
	const { port } = await ready(proc);
	const protocol = RpcClient.layerProtocolSocket().pipe(
		Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`)),
		Layer.provide(Socket.layerWebSocketConstructorGlobal),
		Layer.provide(RpcSerialization.layerNdjson),
	);
	return {
		proc,
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
	const db = new DatabaseSync(join(home, "app.db"));
	try {
		db.prepare(statement).run(...params);
	} finally {
		db.close();
	}
};

export const machineRow = (home: string, id: string) =>
	query(home, "SELECT store_id, cursor FROM machine WHERE id = ?", id)[0] as {
		store_id: string | null;
		cursor: number;
	};

/** Adds the CodeWork server as a remote machine, then waits until the app holds its head. */
export const addMachine = async (home: string, server: Codework, run: Awaited<ReturnType<typeof app>>["run"]) => {
	const id = await run((rpc) => rpc["servers.add"]({ kind: "remote", name: "Scripted", url: server.url }));
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
