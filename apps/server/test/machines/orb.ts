/* @effect-diagnostics nodeBuiltinImport:off -- the machine suite drives OrbStack machines through the orb CLI. */
import { Effect } from "effect";
import { spawn, spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Client from "../../../../packages/codework/src/server/client.ts";
import { Pairing } from "../../src/pairing.ts";

const scripts = fileURLToPath(new URL(".", import.meta.url));
/** The checkout under test: each machine's setup copies it from here through the Mac mount. */
export const checkout = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");

export const available = spawnSync("which", ["orb"]).status === 0;

/** `orb <args>`, failing on a non-zero exit or after `timeout` ms. */
export const orb = (args: ReadonlyArray<string>, options: { input?: string; timeout?: number } = {}) =>
	new Promise<string>((resolve, reject) => {
		const proc = spawn("orb", args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		const timer = setTimeout(() => proc.kill("SIGKILL"), options.timeout ?? 120_000);
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(new Error(`orb ${args.join(" ")} exited ${code}: ${stderr || stdout}`));
		});
		proc.stdin.end(options.input ?? "");
	});

export type Row = Record<string, unknown>;

/** Machines the suite created or found, all Ubuntu; `ubuntu` exists already and is never deleted. */
export const ensure = async (name: string) => {
	const list = await orb(["list", "--format", "json"]);
	const found = (JSON.parse(list) as Array<{ name: string; state: string }>).find((m) => m.name === name);
	if (found === undefined) await orb(["create", "ubuntu", name], { timeout: 600_000 });
	else if (found.state !== "running") await orb(["start", name], { timeout: 300_000 });
};

/** A Linux machine running the fixture CodeWork server (start.sh) on port 7433. */
export const machine = (name: string) => {
	const home = `/home/${userInfo().username}`;
	const cwHome = `${home}/cw-home`;
	const database = `${cwHome}/data/codework.db`;
	const url = `ws://${name}.orb.local:7433/rpc/v1`;
	const node = `${home}/.local/node/bin/node`;
	const script = (file: string, args: ReadonlyArray<string>, timeout?: number) =>
		orb(["-m", name, "bash", join(scripts, file), ...args], { timeout: timeout ?? 120_000 });
	const sh = (command: string, input?: string) => orb(["-m", name, "bash", "-c", command], { input: input ?? "" });
	/** RPC calls made inside the machine over loopback: they work while the network is cut. */
	const drive = async (calls: ReadonlyArray<readonly [string, unknown]>): Promise<Array<unknown>> => {
		const out = await orb(
			["-m", name, node, "--conditions=development", `${home}/codework/apps/server/test/machines/drive.ts`],
			{ input: JSON.stringify(calls) },
		);
		return JSON.parse(out.trim().split("\n").at(-1)!) as Array<unknown>;
	};
	/** A fresh pairing code, as `codework service pair` prints it there. */
	const pair = async () => ((await drive([["device.pair", {}]]))[0] as { code: string }).code;
	// The suite's own device, which its calls from the Mac take tickets with; paired again once refused.
	let session: string | undefined;
	const take = (token: string) => Effect.runPromise(Pairing.ticket(url, token));
	const ticket = async () => {
		const taken = session === undefined ? undefined : await take(session);
		if (taken !== undefined) return taken;
		session = (await Effect.runPromise(Pairing.exchange(url, await pair(), "Suite")))!.token;
		return (await take(session))!;
	};
	return {
		name,
		url,
		cwHome,
		database,
		setup: () => script("setup.sh", [checkout], 1_800_000),
		/**
		 * `env` reaches the server as its environment (credentials a test moves onto the machine). It
		 * goes through stdin, so it never shows on a command line or in an error.
		 */
		start: (env: Readonly<Record<string, string>> = {}) =>
			orb(
				[
					"-m",
					name,
					"bash",
					"-c",
					'while IFS= read -r line && [ -n "$line" ]; do export "$line"; done; exec bash "$0"',
					join(scripts, "start.sh"),
				],
				{
					input: `${Object.entries(env)
						.map(([key, value]) => `${key}=${value}\n`)
						.join("")}\n`,
					timeout: 120_000,
				},
			),
		/** Sweeps the store's open runs as a start would, without listening. */
		sweep: () => script("start.sh", ["sweep"]),
		stop: (signal: "TERM" | "KILL" = "TERM") => script("stop.sh", [signal]),
		net: (mode: "cut" | "restore" | "slow" | "fast") => script("net.sh", [mode]),
		/** A fresh CodeWork home: a new store, keeping the devices paired with it. */
		wipe: () =>
			sh(`[ ! -d ${cwHome} ] || find ${cwHome} -mindepth 1 -maxdepth 1 ! -name devices.json -exec rm -rf {} +`),
		pair,
		sh,
		/** The oldest held reply takes its next step. */
		release: () => sh(`echo release > ${home}/cw.ctl`),
		/** Rows of the harness store, read with sqlite3 inside the machine. */
		sql: async (statement: string): Promise<Array<Row>> => {
			const out = await orb(["-m", name, "sqlite3", "-json", "-cmd", ".timeout 5000", database], {
				input: statement,
			});
			return out.trim() === "" ? [] : (JSON.parse(out) as Array<Row>);
		},
		/** A write through sqlite3 that may be refused: its error text, or undefined when it succeeded. */
		refused: (statement: string) =>
			orb(["-m", name, "sqlite3", "-cmd", ".timeout 5000", database], { input: statement }).then(
				() => undefined,
				(error: Error) => error.message.replace(/^.*exited \d+: /s, "").trim(),
			),
		drive,
		/** Calls from the Mac, on a socket opened with a ticket of the suite's device. */
		run: async <A, E>(use: (rpc: Client.Client) => Effect.Effect<A, E>) => {
			const token = await ticket();
			return Effect.gen(function* () {
				return yield* use(yield* Client.make);
			}).pipe(Effect.scoped, Effect.provide(Client.layer({ url, token })), Effect.runPromise);
		},
	};
};
export type Machine = ReturnType<typeof machine>;
