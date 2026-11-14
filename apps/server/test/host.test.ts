/* @effect-diagnostics nodeBuiltinImport:off -- the suite registers CodeWork servers in temp dirs. */
import { Effect, Option, Stream } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { Contract } from "@codeworksh/contract";
import {
	type AppRpc,
	app,
	cleanup,
	type Codework,
	codework,
	freePort,
	normalizer,
	query,
	snapshot as match,
	stop,
	synced,
	tempDir,
	waitFor,
	write,
} from "./fixtures/apps.ts";

afterEach(cleanup);

const snapshot = (name: string, artifact: unknown) => match(`host.${name}`, artifact);

/** Registers `server` in `home` as its default local server would be, before the app starts. */
const registerLocal = (appHome: string, server: Codework, port: number) => {
	const cli = join(appHome, "cli");
	mkdirSync(cli, { recursive: true });
	writeFileSync(
		join(cli, "service.json"),
		JSON.stringify({ pid: server.proc.pid, version: "0.0.0", url: server.url, port }),
	);
};

const project = (server: Codework, directory: string, name: string) =>
	server.run((rpc) => rpc["session.create"]({ directory, project: { name } }));

/** What each read that names a machine shows, per server as Settings lists them. */
const names = (rpc: AppRpc) =>
	Effect.gen(function* () {
		const sidebar = yield* rpc["sidebar.list"]({ organizationId: Contract.PERSONAL_ORGANIZATION, machines: "all" });
		const threads = yield* rpc["threads.list"]({ organizationId: Contract.PERSONAL_ORGANIZATION, by: "status" });
		yield* rpc["servers.check"](undefined);
		const statuses = yield* rpc["servers.watch"](undefined).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
		const listed = threads.lists.flatMap((list) => list.threads);
		return statuses.map(({ id, name, host, override }) => ({
			id,
			name,
			host,
			override,
			sidebar: sidebar.find((project) => project.machine.id === id)?.machine.name,
			allThreads: listed.find((thread) => thread.machine.id === id)?.machine.name,
		}));
	});

const stored = (appHome: string) => query(appHome, "SELECT id, kind, name, host FROM machine ORDER BY pos");

/** The stored row and every read of each machine. */
const read = async (appHome: string, desk: Awaited<ReturnType<typeof app>>) => {
	const rows = stored(appHome);
	const reads = await desk.run(names);
	return reads.map((machine) => ({ stored: rows.find((row) => row.id === machine.id), ...machine }));
};
const shown = (state: Awaited<ReturnType<typeof read>>, id: string) => {
	const machine = state.find((machine) => machine.id === id);
	return [machine?.name, machine?.sidebar, machine?.allThreads];
};

it("a machine is named by its server's host unless the user names it, else by where it is", async () => {
	const localHome = tempDir("host-local");
	const remoteHome = tempDir("host-remote");
	const olderHome = tempDir("host-older");
	const appHome = tempDir("host-app");
	const localPort = await freePort();
	const remotePort = await freePort();
	const olderPort = await freePort();
	const local = await codework(localHome, localPort, { host: "Studio Mac" });
	let remote = await codework(remoteHome, remotePort, { host: "ubuntu" });
	const older = await codework(olderHome, olderPort, { older: true });
	await project(local, localHome, "Local");
	await project(remote, remoteHome, "Remote");
	await project(older, olderHome, "Older");

	registerLocal(appHome, local, localPort);
	const desk = await app(appHome);
	const remoteId = await desk.run((rpc) => rpc["servers.add"]({ kind: "remote", url: remote.url }));
	const olderId = await desk.run((rpc) => rpc["servers.add"]({ kind: "remote", name: "  ", url: older.url }));
	await synced(appHome, Contract.LOCAL_SERVER, local);
	await synced(appHome, remoteId, remote);
	await synced(appHome, olderId, older);

	const reported = await read(appHome, desk);
	expect(shown(reported, Contract.LOCAL_SERVER)).toEqual(Array(3).fill("Studio Mac"));
	expect(shown(reported, remoteId)).toEqual(Array(3).fill("ubuntu"));
	expect(shown(reported, olderId)).toEqual(Array(3).fill(`127.0.0.1:${olderPort}`));

	await desk.run((rpc) => rpc["servers.update"]({ id: remoteId, name: " Build Box " }));
	const overridden = await read(appHome, desk);
	expect(shown(overridden, remoteId)).toEqual(Array(3).fill("Build Box"));

	await desk.run((rpc) => rpc["servers.update"]({ id: remoteId, name: "" }));
	const cleared = await read(appHome, desk);
	expect(shown(cleared, remoteId)).toEqual(Array(3).fill("ubuntu"));

	// The same server comes back under a new name.
	await stop(remote.proc);
	remote = await codework(remoteHome, remotePort, { host: "ubuntu-2" });
	await waitFor(
		() => (stored(appHome).find((row) => row.id === remoteId)?.host === "ubuntu-2" ? true : undefined),
		"the new host name",
	);
	const renamed = await read(appHome, desk);
	expect(shown(renamed, remoteId)).toEqual(Array(3).fill("ubuntu-2"));

	const steps = { reported, overridden, cleared, renamed };
	expect(JSON.stringify(steps)).not.toContain("CodeWork");
	await snapshot(
		"names",
		normalizer(
			[localHome, remoteHome, olderHome, appHome],
			[
				[remoteId, "<remote machine>"],
				[olderId, "<older machine>"],
				[`127.0.0.1:${olderPort}`, "127.0.0.1:<older port>"],
			],
		)(steps),
	);
}, 90_000);

it("the built-in server's old seed name is no override after the migration", async () => {
	const appHome = tempDir("host-migrate");
	const first = await app(appHome);
	const boxId = await first.run((rpc) =>
		rpc["servers.add"]({ kind: "remote", name: "Box", url: "wss://box.example.test/rpc" }),
	);
	await stop(first.proc);
	// app.db as it was before `host`: the seed's name on the built-in server, a name on every row.
	write(appHome, "ALTER TABLE machine DROP COLUMN host");
	write(appHome, "UPDATE machine SET name = 'CodeWork' WHERE id = 'local'");
	write(appHome, "DELETE FROM effect_sql_migrations WHERE migration_id = 202611140002");

	const second = await app(appHome);
	const servers = await second.run((rpc) =>
		rpc["servers.watch"](undefined).pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
	);
	const migrated = {
		stored: stored(appHome),
		servers: servers.map(({ id, name, host, override }) => ({ id, name, host, override })),
	};
	expect(migrated.stored).toEqual([
		{ id: Contract.LOCAL_SERVER, kind: "local", name: null, host: null },
		{ id: boxId, kind: "remote", name: "Box", host: null },
	]);
	await snapshot("migrated", normalizer([appHome], [[boxId, "<box machine>"]])(migrated));
}, 60_000);
