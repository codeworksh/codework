/* @effect-diagnostics nodeBuiltinImport:off -- the suite spawns the real server in a temp dir and reads its database. */
import { Effect, Option, Stream } from "effect";
import { RpcClient } from "effect/rpc";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { Contract } from "@codeworksh/contract";
import {
	appProtocol,
	cleanup,
	type Codework,
	codework,
	freePort,
	ready,
	type Ready,
	rolled,
	synced,
	tempDir,
} from "./fixtures/apps.ts";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "codework-schema-"));
const database = join(home, "app.db");
let server: ChildProcess;
let started: Ready;
// The remote server a row pairs with.
let remote: Codework;

// The home names no CodeWork service, and none is needed: only the app's own tables are read.
beforeAll(async () => {
	remote = await codework(tempDir("schema-remote"), await freePort());
	server = spawn(process.execPath, [entry], {
		env: {
			...process.env,
			CODEWORK_DATABASE: database,
			CODEWORK_HOME_DIR: home,
			CODEWORK_INSTALL_DIR: join(home, "bin"),
		},
		stdio: ["ignore", "pipe", "inherit"],
	});
	started = await ready(server);
}, 20_000);

afterAll(async () => {
	const exited = new Promise((resolve) => server.once("exit", resolve));
	server.kill("SIGKILL");
	await exited;
	await cleanup();
	rmSync(home, { recursive: true, force: true });
});

const protocol = () => appProtocol(started);

type Row = Record<string, unknown>;

// Clock values differ per run.
const timeless = (row: Row): Row =>
	Object.fromEntries(
		Object.entries(row).map(([key, value]) => [key, key.endsWith("_at") && value !== null ? "<time>" : value]),
	);

// What the sync writes, under a machine: one of every table.
const insertTree = (db: DatabaseSync, machine: string, suffix: string, groupingId: string | null) => {
	const now = 1;
	db.prepare(
		`INSERT INTO project (machine_id, id, organization_id, namespace, name, status, created_at, updated_at)
		 VALUES (?, 'prj', 'personal', 'codework', 'repo', 'active', ?, ?)`,
	).run(machine, now, now);
	db.prepare(
		`INSERT INTO space (machine_id, id, organization_id, project_id, location, kind, status, created_at, updated_at)
		 VALUES (?, 'spc', 'personal', 'prj', '/repo', 'primary', 'active', ?, ?)`,
	).run(machine, now, now);
	db.prepare(
		`INSERT INTO session (id, machine_id, organization_id, space_id, slug, dir, created_at, updated_at)
		 VALUES (?, ?, 'personal', 'spc', 'slug', '/repo', ?, ?)`,
	).run(`ses_${suffix}`, machine, now, now);
	db.prepare(
		`INSERT INTO thread (id, organization_id, session_id, origin_kind, status, status_at, grouping_id, ordering,
		 created_seq, created_at, updated_at)
		 VALUES (?, 'personal', ?, 'main', 'settled', ?, ?, -1, 1, ?, ?)`,
	).run(`thr_${suffix}`, `ses_${suffix}`, now, groupingId, now, now);
	db.prepare(
		`INSERT INTO entry (id, thread_id, seq, type, state, size, created_at, updated_at)
		 VALUES (?, ?, 1, 'user', 'committed', 2, ?, ?)`,
	).run(`ent_${suffix}`, `thr_${suffix}`, now, now);
	db.prepare(`INSERT INTO part (entry_id, part_index, type, data) VALUES (?, 0, 'text', '{}')`).run(`ent_${suffix}`);
	db.prepare(
		`INSERT INTO inbox (id, thread_id, delivery, text, admitted_seq, created_at)
		 VALUES (?, ?, 'followUp', 'next', 2, ?)`,
	).run(`msg_${suffix}`, `thr_${suffix}`, now);
	db.prepare(
		`INSERT INTO usage (machine_id, store_id, hour, thread_id, provider, model, thinking, session_id, project_id,
		 requests, input, output, cache_read, cache_write, reasoning, cost, cost_input, cost_output, cost_cache_read,
		 cost_cache_write, duration, timed, durations, rev)
		 VALUES (?, 'str', 0, ?, 'openai', 'gpt', 'off', ?, 'prj', 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, '[1]', 1)`,
	).run(machine, `thr_${suffix}`, `ses_${suffix}`);
	db.prepare(
		`INSERT INTO tally (machine_id, store_id, hour, thread_id, kind, name, session_id, project_id, count, rev)
		 VALUES (?, 'str', 0, ?, 'tool', 'bash', ?, 'prj', 1, 1)`,
	).run(machine, `thr_${suffix}`, `ses_${suffix}`);
};

const TREE = ["project", "space", "session", "thread", "entry", "part", "inbox", "usage", "tally"] as const;

it("creates the sync tables, seeds them, and cascades a removed machine, keeping its usage", async () => {
	const db = new DatabaseSync(database);
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA foreign_keys = ON");
	const all = (query: string, ...params: Array<string>) => db.prepare(query).all(...params) as Array<Row>;
	const counts = () =>
		Object.fromEntries(TREE.map((table) => [table, all(`SELECT COUNT(*) AS n FROM ${table}`)[0]!.n]));

	const schema = all(
		`SELECT type, name, tbl_name, sql FROM sqlite_master
		 WHERE sql IS NOT NULL AND name NOT LIKE 'effect_sql_%' ORDER BY tbl_name, type DESC, name`,
	).map((row) => ({ ...row, sql: String(row.sql).replace(/\s+/g, " ") }));
	const seeded = {
		machine: all("SELECT * FROM machine").map(timeless),
		organization: all("SELECT * FROM organization").map(timeless),
	};

	const servers = await Effect.gen(function* () {
		const rpc = yield* RpcClient.make(Contract.Api);
		const listed = rpc["servers.check"](undefined).pipe(
			Effect.andThen(rpc["servers.watch"](undefined).pipe(Stream.runHead, Effect.map(Option.getOrThrow))),
			// A local server's executable and process depend on this computer.
			Effect.map((statuses) =>
				statuses.map((status) =>
					status.kind === "local"
						? { id: status.id, kind: status.kind, name: status.name, isDefault: status.isDefault }
						: status,
				),
			),
		);
		const refused = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "accepted" }));

		const code = yield* Effect.promise(() => remote.pair());
		const badUrl = yield* refused(rpc["servers.add"]({ kind: "remote", name: "Cloud", url: "https://x.test", code }));
		const badCode = yield* refused(
			rpc["servers.add"]({ kind: "remote", name: "Cloud", url: remote.url, code: "00000-00000" }),
		);
		const id = yield* rpc["servers.add"]({
			kind: "remote",
			name: "Cloud",
			url: ` ${remote.url} `,
			code: ` ${code} `,
		});
		// Synced before it is listed or moved, so its reported host and sync columns are settled.
		yield* Effect.promise(() => synced(home, id, remote).then(() => rolled(home, id, remote)));
		const added = yield* listed;
		// A new URL keeps the session: the same machine reached another way.
		yield* rpc["servers.update"]({ id, name: "Cloud tunnel", url: "wss://tunnel.example.test/rpc" });
		const updated = yield* listed;
		const localPatch = yield* refused(rpc["servers.update"]({ id, home: "/tmp" }));
		const urlOnLocal = yield* refused(rpc["servers.update"]({ id: "local", url: "wss://x.test/rpc" }));
		const codeOnLocal = yield* refused(rpc["servers.update"]({ id: "local", code }));
		const defaultRemote = yield* refused(rpc["servers.setDefault"]({ id }));
		const serviceRemote = yield* refused(rpc["servers.service"]({ id, action: "start" }));
		const row = timeless(all("SELECT * FROM machine WHERE id = ?", id)[0]!);

		// Rows the sync would have copied, under the remote machine and under the local one.
		db.prepare(
			`INSERT INTO grouping (id, organization_id, name, ordering, created_at, updated_at)
			 VALUES ('grp', 'personal', 'Inbox', 1, 1, 1)`,
		).run();
		insertTree(db, id, "remote", null);
		insertTree(db, "local", "local", "grp");
		const before = counts();
		// Through the server's own connection, so its foreign keys are what cascades.
		yield* rpc["servers.remove"]({ id });
		const after = counts();
		const remoteLeft = all("SELECT id FROM thread WHERE id = 'thr_remote'").length;
		const removed = yield* listed;

		db.prepare("DELETE FROM grouping WHERE id = 'grp'").run();
		const ungrouped = all("SELECT id, grouping_id FROM thread");

		return {
			badUrl,
			badCode,
			added,
			updated,
			refused: { localPatch, urlOnLocal, codeOnLocal, defaultRemote, serviceRemote },
			row,
			cascade: { before, after, remoteLeft },
			removed,
			ungrouped,
		};
	}).pipe(Effect.scoped, Effect.provide(protocol()), Effect.runPromise);
	db.close();

	const steps = { schema, seeded, servers };
	expect(servers.cascade.after).toEqual(
		Object.fromEntries(TREE.map((table) => [table, table === "usage" || table === "tally" ? 2 : 1])),
	);
	expect(servers.ungrouped).toEqual([{ id: "thr_local", grouping_id: null }]);
	// Only the stored row holds the session token; the statuses the page is sent must show none.
	const session = servers.row.token as string;
	expect(JSON.stringify([servers.added, servers.updated])).not.toContain(session);
	const text = JSON.stringify(steps, null, "\t")
		.replaceAll(servers.row.id as string, "<remote>")
		.replaceAll(session, "<session token>")
		.replaceAll(remote.url, "<remote url>")
		.replaceAll(servers.row.store_id as string, "<store>")
		.replaceAll(servers.row.boot as string, "<boot>");
	await expect(`${text}\n`).toMatchFileSnapshot("./__artifacts__/schema.json");
}, 60_000);
