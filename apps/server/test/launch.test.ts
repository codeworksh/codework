/* @effect-diagnostics nodeBuiltinImport:off -- the suite starts real CodeWork servers from temp homes. */
import { Effect, Option, Stream } from "effect";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, it } from "vite-plus/test";
import {
	type CliAction,
	type CliEnvVar,
	Contract,
	type LocalServerStatus,
	type ServerUpdate,
} from "@codeworksh/contract";
import {
	type AppRpc,
	app,
	cleanup,
	freePort,
	normalizer,
	snapshot as match,
	tempDir,
	waitFor,
} from "./fixtures/apps.ts";

const cli = fileURLToPath(new URL("../../../packages/codework/src/index.ts", import.meta.url));
const models = fileURLToPath(new URL("../../../models.gen.json", import.meta.url));

// The servers a case started run detached, outliving the CLI that started them; each is stopped by its pid.
const started = new Set<string>();
afterEach(async () => {
	for (const home of started) {
		const file = join(home, "service.json");
		if (!existsSync(file)) continue;
		const { pid } = JSON.parse(readFileSync(file, "utf8")) as { pid: number };
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	started.clear();
	await cleanup();
});

const snapshot = (name: string, artifact: unknown) => match(`launch.${name}`, artifact);

/**
 * A `codework` that notes each `service` call, its arguments and the environment it was given, then
 * runs the CLI from source. The app runs it as a custom executable, the way the Setup page sets one.
 */
const wrapper = (dir: string) => {
	const log = join(dir, "calls.log");
	const file = join(dir, "codework");
	writeFileSync(
		file,
		[
			"#!/bin/sh",
			'if [ "$1" = service ]; then',
			`  { printf 'args:'; printf ' %s' "$@"; printf '\\n'; printf '  PLAIN_SETTING=%s\\n  SECRET_KEY=%s\\n  CODEWORK_HOME_DIR=%s\\n' "$PLAIN_SETTING" "$SECRET_KEY" "$CODEWORK_HOME_DIR"; } >> '${log}'`,
			"fi",
			`exec '${process.execPath}' --conditions=development '${cli}' "$@"`,
			"",
		].join("\n"),
	);
	chmodSync(file, 0o755);
	return { file, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []) };
};

const localOf = (rpc: AppRpc) =>
	Effect.gen(function* () {
		yield* rpc["servers.check"](undefined);
		const statuses = yield* rpc["servers.watch"](undefined).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
		return statuses.find((status): status is LocalServerStatus => status.id === Contract.LOCAL_SERVER)!;
	});

/** What the Setup page reads from a local server: its runtime settings and whether it runs where they say. */
const shown = (status: LocalServerStatus) => ({
	cli: status.cli !== null && "version" in status.cli ? { ...status.cli, version: "<version>" } : status.cli,
	home: status.home,
	args: status.args,
	env: status.env,
	server: status.server._tag === "Running" ? { _tag: "Running", url: status.server.url } : status.server,
});

it(
	"starts, restarts and stops a server with a custom executable, home, arguments and variables",
	{ timeout: 180_000 },
	async () => {
		const appHome = tempDir("launch-app");
		const osHome = tempDir("launch-os");
		const bin = tempDir("launch-bin");
		const home = tempDir("launch-home");
		started.add(home);
		started.add(join(appHome, "cli"));
		const codework = wrapper(bin);
		const [first, second] = [await freePort(), await freePort()];
		const desk = await app(appHome, {
			// Nothing of the developer's: no install folder, no login shell PATH, no OS home.
			HOME: osHome,
			SHELL: "/usr/bin/false",
			CODEWORK_INSTALL_DIR: join(osHome, "bin"),
			CODEWORK_MODELS_FILE: models,
		});
		// Each folder keeps a label of its own, so the artifact shows which home the server ran in.
		const label = normalizer(
			[],
			[
				[join(appHome, "cli"), "<default home>"],
				[bin, "<bin>"],
				[home, "<custom home>"],
				[`:${first}`, ":<port 1>"],
				[`:${second}`, ":<port 2>"],
				[`--port ${first}`, "--port <port 1>"],
				[`--port ${second}`, "--port <port 2>"],
			],
		);
		const update = (patch: Omit<ServerUpdate, "id">) =>
			desk.run((rpc) => rpc["servers.update"]({ id: Contract.LOCAL_SERVER, ...patch }));
		const act = (action: CliAction) =>
			desk.run((rpc) => rpc["servers.service"]({ id: Contract.LOCAL_SERVER, action }));
		const status = () => desk.run(localOf);
		const running = (port: number) =>
			waitFor(
				async () => {
					const now = await status();
					return now.server._tag === "Running" && now.server.url.includes(`:${port}`) ? now : undefined;
				},
				`the server on port ${port}`,
				60_000,
			);

		const before = await status();

		const env: Array<CliEnvVar> = [
			{ name: "PLAIN_SETTING", value: "plain value", sensitive: false },
			{ name: "SECRET_KEY", value: "s3cret", sensitive: true },
		];
		await update({ executable: codework.file, home, args: `--port ${first}`, env });
		const saved = await status();

		await act("start");
		const afterStart = await running(first);
		const callsAfterStart = codework.calls();

		// The secret is sent back without its value, as the Setup page sends a kept one: it stays saved.
		await update({
			args: `--port ${second}`,
			env: [
				{ name: "PLAIN_SETTING", value: "changed", sensitive: false },
				{ name: "SECRET_KEY", sensitive: true },
			],
		});
		await act("restart");
		const afterRestart = await running(second);

		await act("stop");
		const afterStop = await waitFor(async () => {
			const now = await status();
			return now.server._tag === "Stopped" ? now : undefined;
		}, "the server to stop");

		await update({ executable: null, home: null, args: "", env: [] });
		const reset = await status();

		await snapshot(
			"settings",
			label({
				before: shown(before),
				saved: shown(saved),
				afterStart: shown(afterStart),
				callsAfterStart,
				afterRestart: shown(afterRestart),
				afterStop: shown(afterStop),
				calls: codework.calls(),
				reset: shown(reset),
			}),
		);
	},
);
