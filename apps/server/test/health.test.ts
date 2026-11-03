/* @effect-diagnostics nodeBuiltinImport:off -- the suite spawns the real server in a temp dir. */
import { Effect, Layer, Option, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { Contract, type ServerStatus } from "@codeworksh/contract";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = fileURLToPath(new URL("../../../packages/codework/src/index.ts", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "codework-health-"));
// A second server's home, whose registration names a pid this machine has no process for, as one written
// by a server in WSL does for the Windows app.
const otherHome = mkdtempSync(join(tmpdir(), "codework-health-other-"));
let server: ChildProcess;
let codework: ChildProcess | undefined;
let port: number;

const kill = (child: ChildProcess) =>
	new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve();
		child.once("exit", () => resolve());
		child.kill("SIGKILL");
	});

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
		// Its other lines are logs, as the desktop app reads them.
		createInterface({ input: server.stdout! }).on("line", (line) => {
			if (!line.startsWith('{"type":"ready"')) return;
			const message = JSON.parse(line) as { type?: string; port?: number };
			if (message.type === "ready" && message.port !== undefined) resolve(message.port);
		});
	});
}, 20_000);

afterAll(async () => {
	if (codework !== undefined) await kill(codework);
	await kill(server);
	rmSync(home, { recursive: true, force: true });
	rmSync(otherHome, { recursive: true, force: true });
});

const protocol = () =>
	RpcClient.layerProtocolSocket().pipe(
		Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`)),
		Layer.provide(Socket.layerWebSocketConstructorGlobal),
		Layer.provide(RpcSerialization.layerNdjson),
	);

const defaultTag = (statuses: ReadonlyArray<ServerStatus>) => statuses.find((status) => status.isDefault)?.server._tag;
const tagOf = (statuses: ReadonlyArray<ServerStatus>, id: string) =>
	statuses.find((status) => status.id === id)?.server._tag;

it("tells a server runs from its URL, whatever its registered pid", async () => {
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

		// Every server checked now, as read right after.
		const checked = rpc["servers.check"](undefined).pipe(
			Effect.andThen(watch.pipe(Stream.runHead, Effect.map(Option.getOrThrow))),
		);
		const registration = join(home, "service.json");

		const first = yield* until("Stopped");

		// The real CLI, serving from this home: the app finds it through the registration it writes.
		codework = spawn(process.execPath, ["--conditions=development", cli, "serve", "--port", "0"], {
			env: { ...process.env, CODEWORK_HOME_DIR: home },
			stdio: "ignore",
		});
		const running = yield* until("Running");

		// The same server registered with a pid no process here has: its URL alone says it runs.
		const otherId = yield* rpc["servers.add"]({ name: "Other OS", executable: null, home: otherHome, args: "" });
		const registered = JSON.parse(readFileSync(registration, "utf8")) as { pid: number };
		writeFileSync(join(otherHome, "service.json"), JSON.stringify({ ...registered, pid: 2_147_483_646 }));
		const otherOs = tagOf(yield* checked, otherId);

		// Killed outright, the server leaves its registration behind; nothing answers at its URL.
		yield* Effect.promise(() => kill(codework!));
		const killed = yield* until("Stopped");
		const leftBehind = existsSync(registration);
		const otherOsKilled = tagOf(yield* checked, otherId);

		// A registration whose pid lives (this test) but whose URL nobody answers: stopped, not unreachable.
		writeFileSync(
			registration,
			JSON.stringify({ pid: process.pid, version: "0.0.0", url: "ws://127.0.0.1:9/rpc", port: 9 }),
		);
		const stale = defaultTag(yield* checked);

		rmSync(registration);
		const gone = yield* until("Stopped");

		const health = yield* rpc["servers.health"](undefined);
		yield* rpc["servers.setHealth"]({ interval: 60 });
		const changed = yield* rpc["servers.health"](undefined);

		return { first, running, otherOs, killed, leftBehind, otherOsKilled, stale, gone, health, changed };
	}).pipe(Effect.scoped, Effect.provide(protocol()), Effect.runPromise);

	expect(steps.running).toBe("Running");
	expect(steps.otherOs).toBe("Running");
	expect(steps.stale).toBe("Stopped");
	expect(steps.changed).toEqual({ interval: 60 });
	await expect(`${JSON.stringify(steps, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/health.json");
}, 120_000);
