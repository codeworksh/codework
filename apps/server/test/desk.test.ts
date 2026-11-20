/* @effect-diagnostics nodeBuiltinImport:off -- the suite spawns the real server in a temp dir. */
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { Contract } from "@codeworksh/contract";
import { appProtocol, ready, type Ready } from "./fixtures/apps.ts";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "codework-desk-"));
let server: ChildProcess;
let started: Ready;

// CODEWORK_HOME_DIR keeps the server from finding a real CodeWork service; desk and tab
// RPCs never need one. The same database is reused across starts.
async function start() {
	server = spawn(process.execPath, [entry], {
		env: { ...process.env, CODEWORK_DATABASE: join(home, "app.db"), CODEWORK_HOME_DIR: home },
		stdio: ["ignore", "pipe", "inherit"],
	});
	started = await ready(server);
}

async function stop() {
	const exited = new Promise((resolve) => server.once("exit", resolve));
	// The server does not yet stop on SIGTERM while no CodeWork service is registered.
	server.kill("SIGKILL");
	await exited;
}

beforeAll(start, 20_000);

afterAll(async () => {
	await stop();
	rmSync(home, { recursive: true, force: true });
});

// Provided around the whole scenario: the socket lives as long as the layer does.
const protocol = () => appProtocol(started);

it("desk round-trips and follows tab deletion", async () => {
	// Instances are listed in tile order, as desk.get returns them.
	const steps = await Effect.gen(function* () {
		const rpc = yield* RpcClient.make(Contract.Api);
		const empty = yield* rpc["desk.get"]();

		// Two tabs, so a frame on both outlives deleting one of them.
		const other = yield* rpc["tabs.create"]({ name: "Other" });
		const tab = yield* rpc["tabs.create"]({ name: "Scratch" });
		const bit = 1 << tab.bit;
		const otherBit = 1 << other.bit;
		const saved: Contract.Desk = {
			instances: [
				{
					id: "browser-1",
					kind: "browser",
					tags: bit | otherBit,
					props: {},
					pinned: false,
					title: "Docs",
					address: "https://example.com",
					params: { zoom: 1.25, history: ["a", "b"] },
					openedBy: "notes-1",
				},
				{ id: "notes-1", kind: "notes", tags: bit, props: { text: "hello" }, pinned: true },
			],
			tileOrder: ["browser-1", "notes-1"],
			focusOrder: ["notes-1", "browser-1"],
		};
		yield* rpc["desk.save"](saved);
		const roundTrip = yield* rpc["desk.get"]();

		yield* rpc["tabs.delete"]({ id: tab.id });
		const afterDelete = yield* rpc["desk.get"]();

		const badOrder = yield* rpc["desk.save"]({ ...afterDelete, tileOrder: [] }).pipe(Effect.flip);
		const duplicate = yield* rpc["desk.save"]({
			...afterDelete,
			focusOrder: [...afterDelete.focusOrder, ...afterDelete.focusOrder],
		}).pipe(Effect.flip);

		// Two auto tabs: one keeps a frame, the other is left empty without being closed.
		const kept = yield* rpc["tabs.create"]({ name: "Kept", auto: true });
		// What its tab last read, as its frame set it.
		yield* rpc["tabs.update"]({ id: kept.id, label: "Kept / A session" });
		yield* rpc["tabs.create"]({ name: "Stray", auto: true });
		yield* rpc["desk.save"]({
			instances: [{ id: "notes-2", kind: "notes", tags: 1 << kept.bit, props: {}, pinned: false }],
			tileOrder: ["notes-2"],
			focusOrder: ["notes-2"],
		});

		return {
			empty,
			other: { ...other, id: "<other>" },
			tab: { ...tab, id: "<tab>" },
			saved,
			roundTrip,
			afterDelete,
			errors: [badOrder, duplicate].map((error) => ({ tag: error._tag, message: error.message })),
		};
	}).pipe(Effect.scoped, Effect.provide(protocol()), Effect.runPromise);

	expect(steps.roundTrip).toEqual(steps.saved);
	expect(steps.afterDelete.instances).toEqual([{ ...steps.saved.instances[0], tags: 1 << steps.other.bit }]);

	// A restart sweeps the empty auto tab and keeps the one with a frame.
	await stop();
	await start();
	const afterRestart = await Effect.gen(function* () {
		const rpc = yield* RpcClient.make(Contract.Api);
		const tabs = yield* rpc["tabs.list"]();
		const desk = yield* rpc["desk.get"]();
		return { tabs: tabs.map(({ name, auto, pos, label }) => ({ name, auto, pos, label })), desk };
	}).pipe(Effect.scoped, Effect.provide(protocol()), Effect.runPromise);
	expect(afterRestart.tabs.map((tab) => tab.name)).toEqual(["Other", "Kept"]);
	// A tab's last label survives the restart, so it names what it shows before its frame loads.
	expect(afterRestart.tabs.map((tab) => tab.label)).toEqual([undefined, "Kept / A session"]);

	await expect(`${JSON.stringify({ ...steps, afterRestart }, null, "\t")}\n`).toMatchFileSnapshot(
		"./__artifacts__/desk.json",
	);
}, 30_000);
