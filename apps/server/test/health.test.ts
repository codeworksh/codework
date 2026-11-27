/* @effect-diagnostics nodeBuiltinImport:off -- the suite spawns the real server in a temp dir. */
import { Effect, Option, Stream } from "effect";
import { RpcClient } from "effect/rpc";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { Contract, type ServerStatus } from "@codeworksh/contract";
import { appProtocol, ready, type Ready } from "./fixtures/apps.ts";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = fileURLToPath(new URL("../../../packages/codework/src/index.ts", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "codework-health-"));
let server: ChildProcess;
let codework: ChildProcess | undefined;
let started: Ready;

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
	started = await ready(server);
}, 20_000);

afterAll(async () => {
	if (codework !== undefined) await kill(codework);
	await kill(server);
	rmSync(home, { recursive: true, force: true });
});

const protocol = () => appProtocol(started);

const tagOf = (statuses: ReadonlyArray<ServerStatus>, found: (status: ServerStatus) => boolean) => {
	const status = statuses.find(found);
	return status?.kind === "local" ? status.server._tag : undefined;
};
const defaultTag = (statuses: ReadonlyArray<ServerStatus>) => tagOf(statuses, (status) => status.isDefault);

it("tells a server runs from its URL, not from a registration alone", async () => {
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

		// Killed outright, the server leaves its registration behind; nothing answers at its URL.
		yield* Effect.promise(() => kill(codework!));
		const killed = yield* until("Stopped");
		const leftBehind = existsSync(registration);

		// A registration whose pid lives (this test) but whose URL nobody answers: stopped, not unreachable.
		writeFileSync(
			registration,
			JSON.stringify({ pid: process.pid, version: "0.0.0", url: "ws://127.0.0.1:9/rpc", port: 9, token: "stale" }),
		);
		const stale = defaultTag(yield* checked);

		rmSync(registration);
		const gone = yield* until("Stopped");

		const health = yield* rpc["servers.health"](undefined);
		yield* rpc["servers.setHealth"]({ interval: 60 });
		const changed = yield* rpc["servers.health"](undefined);

		return { first, running, killed, leftBehind, stale, gone, health, changed };
	}).pipe(Effect.scoped, Effect.provide(protocol()), Effect.runPromise);

	expect(steps.running).toBe("Running");
	expect(steps.stale).toBe("Stopped");
	expect(steps.changed).toEqual({ interval: 60 });
	await expect(`${JSON.stringify(steps, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/health.json");
}, 120_000);

/**
 * The interval is the only thing that looks at the CLI again on its own: a `codework` whose version
 * changes is seen within an interval, never at 0, and at once on a manual check.
 */
it("checks the servers again every interval, and not at 0", async () => {
	const version = join(home, "version.txt");
	const fake = join(home, "fake-codework");
	writeFileSync(fake, `#!/bin/sh\nif [ "$1" = --version ]; then cat '${version}'; exit 0; fi\nexit 1\n`, {
		mode: 0o755,
	});
	const steps = await Effect.gen(function* () {
		const rpc = yield* RpcClient.make(Contract.Api);
		// The version the app last saw, as any reader of the statuses gets it now.
		const seen = rpc["servers.watch"](undefined).pipe(
			Stream.runHead,
			Effect.map(Option.getOrThrow),
			Effect.map((statuses) => {
				const local = statuses.find((status) => status.id === Contract.LOCAL_SERVER);
				return local?.kind === "local" && local.cli !== null && "version" in local.cli ? local.cli.version : null;
			}),
		);
		const waitFor = (expected: string, within: number) =>
			Effect.gen(function* () {
				const start = Date.now();
				while (Date.now() - start < within) {
					if ((yield* seen) === expected) return Date.now() - start;
					yield* Effect.sleep("100 millis");
				}
				return null;
			});

		writeFileSync(version, "codework v1.0.0\n");
		yield* rpc["servers.update"]({ id: Contract.LOCAL_SERVER, executable: fake });
		const set = yield* seen;

		yield* rpc["servers.setHealth"]({ interval: 1 });
		writeFileSync(version, "codework v1.0.1\n");
		const tookAtOne = yield* waitFor("1.0.1", 5_000);

		yield* rpc["servers.setHealth"]({ interval: 0 });
		// A check the 1s timer already began finishes first.
		yield* Effect.sleep("1500 millis");
		writeFileSync(version, "codework v1.0.2\n");
		yield* Effect.sleep("4 seconds");
		const atZero = yield* seen;

		yield* rpc["servers.check"](undefined);
		const afterCheck = yield* seen;

		yield* rpc["servers.setHealth"]({ interval: 300 });
		yield* rpc["servers.update"]({ id: Contract.LOCAL_SERVER, executable: null });
		return { set, seenWithinTwoSecondsAtOne: tookAtOne !== null && tookAtOne <= 2_000, atZero, afterCheck };
	}).pipe(Effect.scoped, Effect.provide(protocol()), Effect.runPromise);

	expect(steps).toEqual({ set: "1.0.0", seenWithinTwoSecondsAtOne: true, atZero: "1.0.1", afterCheck: "1.0.2" });
	await expect(`${JSON.stringify(steps, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/health.interval.json");
}, 60_000);
