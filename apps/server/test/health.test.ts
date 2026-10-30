/* @effect-diagnostics nodeBuiltinImport:off -- the suite spawns the real server in a temp dir. */
import { Effect, Layer, Option, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { Contract, type ServerStatus } from "@codeworksh/contract";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "codework-health-"));
let server: ChildProcess;
let port: number;

// The home names no CodeWork service until the test writes one; the install folder is empty too.
beforeAll(async () => {
	server = spawn(process.execPath, [entry], {
		env: {
			...process.env,
			CODEWORK_DATABASE: join(home, "app.db"),
			CODEWORK_HOME_DIR: home,
			CODEWORK_INSTALL_DIR: join(home, "bin"),
		},
		stdio: ["ignore", "pipe", "inherit"],
	});
	port = await new Promise<number>((resolve, reject) => {
		server.once("exit", (code) => reject(new Error(`server exited before ready (code ${code})`)));
		createInterface({ input: server.stdout! }).on("line", (line) => {
			const message = JSON.parse(line) as { type?: string; port?: number };
			if (message.type === "ready" && message.port !== undefined) resolve(message.port);
		});
	});
}, 20_000);

afterAll(async () => {
	const exited = new Promise((resolve) => server.once("exit", resolve));
	server.kill("SIGKILL");
	await exited;
	rmSync(home, { recursive: true, force: true });
});

const protocol = () =>
	RpcClient.layerProtocolSocket().pipe(
		Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`)),
		Layer.provide(Socket.layerWebSocketConstructorGlobal),
		Layer.provide(RpcSerialization.layerNdjson),
	);

const defaultTag = (statuses: ReadonlyArray<ServerStatus>) => statuses.find((status) => status.isDefault)?.server._tag;

it("keeps the servers' status and follows the default server going up and down", async () => {
	const steps = await Effect.gen(function* () {
		const rpc = yield* RpcClient.make(Contract.Api);
		const watch = rpc["servers.watch"](undefined);
		// The next status whose default server reads `tag`; every reader is sent the same one.
		const until = (tag: string) =>
			watch.pipe(
				Stream.map(defaultTag),
				Stream.filter((seen) => seen === tag),
				Stream.runHead,
				Effect.map(Option.getOrUndefined),
				Effect.timeout("20 seconds"),
			);

		const first = yield* until("Stopped");

		// A registration whose process lives (this test) but whose server never answers.
		writeFileSync(
			join(home, "service.json"),
			JSON.stringify({ pid: process.pid, version: "0.0.0", url: "ws://127.0.0.1:9/rpc", port: 9 }),
		);
		const registered = yield* until("Unreachable");

		rmSync(join(home, "service.json"));
		const gone = yield* until("Stopped");

		const health = yield* rpc["servers.health"](undefined);
		yield* rpc["servers.setHealth"]({ interval: 60 });
		const changed = yield* rpc["servers.health"](undefined);

		return { first, registered, gone, health, changed };
	}).pipe(Effect.scoped, Effect.provide(protocol()), Effect.runPromise);

	expect(steps.registered).toBe("Unreachable");
	expect(steps.changed).toEqual({ interval: 60 });
	await expect(`${JSON.stringify(steps, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/health.json");
}, 60_000);
