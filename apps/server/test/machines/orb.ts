/* @effect-diagnostics nodeBuiltinImport:off -- the machine suite drives OrbStack machines through the orb CLI. */
import { Effect } from "effect";
import { spawn, spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "../../../../packages/codework/src/server/client.ts";

const scripts = fileURLToPath(new URL(".", import.meta.url));
/** The checkout under test: each machine overlays its sources from here through the Mac mount. */
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

/** Machines the suite created or found; `fedora` exists already and is never deleted. */
export const ensure = async (name: string, distro = "ubuntu") => {
	const list = await orb(["list", "--format", "json"]);
	const found = (JSON.parse(list) as Array<{ name: string; state: string }>).find((m) => m.name === name);
	if (found === undefined) await orb(["create", distro, name], { timeout: 600_000 });
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
	return {
		name,
		url,
		cwHome,
		database,
		setup: () => script("setup.sh", [checkout], 1_800_000),
		start: () => script("start.sh", [checkout]),
		/** Sweeps the store's open runs as a start would, without listening. */
		sweep: () => script("start.sh", [checkout, "sweep"]),
		stop: (signal: "TERM" | "KILL" = "TERM") => script("stop.sh", [signal]),
		net: (mode: "cut" | "restore" | "slow" | "fast") => script("net.sh", [mode]),
		/** A fresh CodeWork home: a new store. */
		wipe: () => sh(`rm -rf ${cwHome}`),
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
		/** RPC calls made inside the machine over loopback: they work while the network is cut. */
		drive: async (calls: ReadonlyArray<readonly [string, unknown]>): Promise<Array<unknown>> => {
			const out = await orb(
				["-m", name, node, "--conditions=development", `${home}/codework/apps/server/test/machines/drive.ts`],
				{ input: JSON.stringify(calls) },
			);
			return JSON.parse(out.trim().split("\n").at(-1)!) as Array<unknown>;
		},
		run: <A, E>(use: (rpc: Client.Client) => Effect.Effect<A, E>) =>
			Effect.gen(function* () {
				return yield* use(yield* Client.make);
			}).pipe(Effect.scoped, Effect.provide(Client.layer(url)), Effect.runPromise),
	};
};
export type Machine = ReturnType<typeof machine>;
