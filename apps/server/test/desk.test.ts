/* @effect-diagnostics nodeBuiltinImport:off -- the suite spawns the real server in a temp dir. */
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { Contract } from "@codeworksh/contract";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "codework-desk-"));
let server: ChildProcess;
let port: number;

// CODEWORK_HOME_DIR keeps the server from finding a real CodeWork service; desk and workspace
// RPCs never need one. The same database is reused across starts.
async function start() {
	server = spawn(process.execPath, [entry], {
		env: { ...process.env, CODEWORK_DATABASE: join(home, "app.db"), CODEWORK_HOME_DIR: home },
		stdio: ["ignore", "pipe", "inherit"],
	});
	port = await new Promise<number>((resolve, reject) => {
		server.once("exit", (code) => reject(new Error(`server exited before ready (code ${code})`)));
		createInterface({ input: server.stdout! }).on("line", (line) => {
			const message = JSON.parse(line) as { type?: string; port?: number };
			if (message.type === "ready" && message.port !== undefined) resolve(message.port);
		});
	});
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
const protocol = () =>
	RpcClient.layerProtocolSocket().pipe(
		Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`)),
		Layer.provide(Socket.layerWebSocketConstructorGlobal),
		Layer.provide(RpcSerialization.layerNdjson),
	);

it("desk round-trips and follows workspace deletion", async () => {
	// Instances are listed in tile order, as desk.get returns them.
	const steps = await Effect.gen(function* () {
		const rpc = yield* RpcClient.make(Contract.Api);
		const empty = yield* rpc["desk.get"]();

		const workspace = yield* rpc["workspaces.create"]({ name: "Scratch" });
		const bit = 1 << workspace.bit;
		const saved: Contract.Desk = {
			instances: [
				{
					id: "browser-1",
					kind: "browser",
					tags: bit | 1,
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

		yield* rpc["workspaces.delete"]({ id: workspace.id });
		const afterDelete = yield* rpc["desk.get"]();

		const badOrder = yield* rpc["desk.save"]({ ...afterDelete, tileOrder: [] }).pipe(Effect.flip);
		const duplicate = yield* rpc["desk.save"]({
			...afterDelete,
			focusOrder: [...afterDelete.focusOrder, ...afterDelete.focusOrder],
		}).pipe(Effect.flip);

		// Two auto workspaces: one keeps a frame, the other is left empty without being closed.
		const kept = yield* rpc["workspaces.create"]({ name: "Kept", auto: true });
		yield* rpc["workspaces.create"]({ name: "Stray", auto: true });
		yield* rpc["desk.save"]({
			instances: [{ id: "notes-2", kind: "notes", tags: 1 << kept.bit, props: {}, pinned: false }],
			tileOrder: ["notes-2"],
			focusOrder: ["notes-2"],
		});

		return {
			empty,
			workspace: { ...workspace, id: "<workspace>" },
			saved,
			roundTrip,
			afterDelete,
			errors: [badOrder, duplicate].map((error) => ({ tag: error._tag, message: error.message })),
		};
	}).pipe(Effect.scoped, Effect.provide(protocol()), Effect.runPromise);

	expect(steps.roundTrip).toEqual(steps.saved);
	expect(steps.afterDelete.instances).toEqual([{ ...steps.saved.instances[0], tags: 1 }]);

	// A restart sweeps the empty auto workspace and keeps the one with a frame.
	await stop();
	await start();
	const afterRestart = await Effect.gen(function* () {
		const rpc = yield* RpcClient.make(Contract.Api);
		const workspaces = yield* rpc["workspaces.list"]();
		const desk = yield* rpc["desk.get"]();
		return { workspaces: workspaces.map(({ name, auto, pos }) => ({ name, auto, pos })), desk };
	}).pipe(Effect.scoped, Effect.provide(protocol()), Effect.runPromise);
	expect(afterRestart.workspaces.map((workspace) => workspace.name)).toEqual(["Main", "Code", "Notes", "Kept"]);

	await expect(`${JSON.stringify({ ...steps, afterRestart }, null, "\t")}\n`).toMatchFileSnapshot(
		"./__artifacts__/desk.json",
	);
}, 30_000);
