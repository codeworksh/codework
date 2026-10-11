/* @effect-diagnostics nodeBuiltinImport:off -- this suite spawns the CLI and a fake TUI as child processes. */
/* @effect-diagnostics globalTimers:off globalDate:off -- polling a spawned process from the test host is not Effect code. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const models = fileURLToPath(new URL("../../../models.gen.json", import.meta.url));

/**
 * A stand-in for the Rust TUI. It writes what the launcher gave it to its own
 * stderr and exits with a chosen code, so a test can assert the contract the
 * launcher promises without building the real binary.
 */
const fake = (dir: string, body: string): string => {
	const path = join(dir, "fake-tui.mjs");
	writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
	// The launcher execs the binary directly, so the stand-in needs the bit too.
	chmodSync(path, 0o755);
	return path;
};

const report = (dir: string) =>
	fake(
		dir,
		[
			'import process from "node:process";',
			"process.stderr.write(JSON.stringify({",
			"  server: process.env.CODEWORK_RPC_SERVER,",
			"  home: process.env.CODEWORK_HOME_DIR,",
			"  args: process.argv.slice(2),",
			`  cwd: process.cwd(),`,
			'}) + "\\n");',
			// Held open like a real session until the test signals it.
			"if (process.env.FAKE_TUI_HOLD) setInterval(() => {}, 1000);",
			"else process.exit(Number(process.env.FAKE_TUI_EXIT ?? 0));",
		].join("\n"),
	);

const homes: string[] = [];
const servers: ChildProcess[] = [];

const home = () => {
	const dir = mkdtempSync(join(tmpdir(), "codework-tui-"));
	homes.push(dir);
	return dir;
};

afterEach(() => {
	// SIGTERM, not SIGKILL: the CLI forwards it, so a held fake TUI exits with it.
	for (const server of servers.splice(0)) server.kill("SIGTERM");
	// A managed server is detached and outlives its CLI, so it must be stopped by
	// the pid in its registration or it would hold the port for the next case.
	for (const dir of homes.splice(0)) {
		try {
			const info = JSON.parse(readFileSync(join(dir, "service.json"), "utf8")) as { pid: number };
			process.kill(info.pid, "SIGKILL");
		} catch {
			// No registration, or the server already exited.
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

const spawnCli = (dir: string, env: NodeJS.ProcessEnv, args: ReadonlyArray<string>) => {
	const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: dir, CODEWORK_MODELS_FILE: models, ...env };
	return spawn(process.execPath, ["--conditions=development", cli, "--home", dir, "--database", ":memory:", ...args], {
		env: childEnv,
		cwd: dir,
	});
};

/** A background `codework tui`, held open by the fake binary until it is signalled. */
const hold = (dir: string, env: NodeJS.ProcessEnv, args: ReadonlyArray<string>) => {
	const child = spawnCli(dir, env, args);
	servers.push(child);
	return child;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("timed out waiting for condition");
};

const readReport = async (child: ChildProcess): Promise<Record<string, unknown>> =>
	new Promise((resolve, reject) => {
		let buffer = "";
		child.stderr?.on("data", (chunk) => {
			buffer += String(chunk);
			// The CLI may print a startup notice first; the report is the JSON line.
			const line = buffer.split("\n").find((candidate) => candidate.startsWith("{") && candidate.endsWith("}"));
			if (line !== undefined) {
				try {
					resolve(JSON.parse(line));
				} catch (error) {
					reject(error);
				}
			}
		});
		child.once("exit", (code) => {
			if (buffer.includes("{")) return;
			reject(new Error(`fake TUI exited with ${code} before reporting`));
		});
	});

const registration = (dir: string) =>
	JSON.parse(readFileSync(join(dir, "service.json"), "utf8")) as {
		url: string;
		port: number;
		pid: number;
		version: string;
	};

/** `codework service ...` against `dir`, asserting it succeeds quietly. */
const service = (dir: string, ...args: ReadonlyArray<string>) => {
	const result = spawnSync(
		process.execPath,
		["--conditions=development", cli, "--home", dir, "--database", ":memory:", "service", ...args],
		{ encoding: "utf8", env: { ...process.env, HOME: dir, CODEWORK_MODELS_FILE: models }, timeout: 30_000 },
	);
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	return result.stdout;
};

const dead = (pid: number) => {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
};

const exitCode = (child: ChildProcess) =>
	new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));

describe("codework tui", () => {
	it("documents the command, its server flag and forwarded arguments", () => {
		const result = spawnSync(process.execPath, ["--conditions=development", cli, "tui", "--help"], {
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Launch the CodeWork terminal UI");
		expect(result.stdout).toContain("--server");
		expect(result.stdout).toContain("--port");
		expect(result.stdout).toContain("<args...>");
	});

	it("rejects server-owned flags when --server names a running server", () => {
		const result = spawnSync(
			process.execPath,
			["--conditions=development", cli, "--home", home(), "tui", "--server", "ws://127.0.0.1:1/rpc/v1"],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("belong on codework serve");
	});

	it("fails clearly when --server does not answer as a CodeWork server", () => {
		const result = spawnSync(
			process.execPath,
			["--conditions=development", cli, "tui", "--server", "ws://127.0.0.1:1/rpc/v1"],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no CodeWork server answered at ws://127.0.0.1:1/rpc/v1");
	});

	it("starts a managed server, registers it, and launches the TUI against its endpoint", async () => {
		const dir = home();
		const binary = report(dir);
		const child = hold(dir, { CODEWORK_TUI_BIN: binary }, ["tui", "--port", "7601", "hello", "world"]);
		const reported = readReport(child);

		await waitFor(() => existsSync(join(dir, "service.json")));
		const info = registration(dir);
		expect(info.pid).toBeGreaterThan(0);

		const message = await reported;
		// What the server files and what the TUI is handed: the discovery contract.
		await expect(
			JSON.stringify(
				{
					serviceJson: { ...info, pid: "<pid>" },
					tui: {
						...message,
						home: message.home === dir ? "<home>" : message.home,
						cwd: realpathSync(String(message.cwd)) === realpathSync(dir) ? "<home>" : message.cwd,
					},
				},
				null,
				"\t",
			) + "\n",
		).toMatchFileSnapshot("./__artifacts__/tui.managed.json");
		expect(message.home).toBe(dir);

		child.kill("SIGKILL");
	}, 30_000);

	it("reuses a registered server instead of starting another", async () => {
		const dir = home();
		const binary = report(dir);
		const first = hold(dir, { CODEWORK_TUI_BIN: binary }, ["tui", "--port", "7602"]);
		const firstMessage = await readReport(first);
		expect(firstMessage.server).toBe("ws://127.0.0.1:7602/rpc/v1");
		first.kill("SIGKILL");
		// Let the first CLI release the port before the second attaches.
		await new Promise((resolve) => setTimeout(resolve, 300));

		const started = registration(dir).pid;
		const second = spawnCli(dir, { CODEWORK_TUI_BIN: binary }, ["tui", "--port", "7602"]);
		let stderr = "";
		second.stderr.on("data", (chunk) => (stderr += String(chunk)));
		const secondMessage = await readReport(second);
		expect(secondMessage.server).toBe("ws://127.0.0.1:7602/rpc/v1");
		// The same server was adopted: same pid, and no startup notice.
		expect(registration(dir).pid).toBe(started);
		expect(stderr).not.toContain("Starting CodeWork server");
	}, 30_000);

	it("forwards the TUI's exit status as the command's own", async () => {
		const dir = home();
		const binary = report(dir);
		const child = spawnCli(dir, { CODEWORK_TUI_BIN: binary, FAKE_TUI_EXIT: "7" }, ["tui", "--port", "7603"]);

		const code = await exitCode(child);
		expect(code).toBe(7);
	}, 30_000);

	it("passes the resolved home to the TUI so it reads the same installation", async () => {
		const dir = home();
		const binary = report(dir);
		const child = spawnCli(dir, { CODEWORK_TUI_BIN: binary }, ["tui", "--port", "7604"]);

		const message = await readReport(child);
		expect(message.home).toBe(dir);

		child.kill("SIGKILL");
	}, 30_000);

	it("reports a startup failure when a managed server cannot bind", async () => {
		const dir = home();
		const binary = report(dir);
		// Occupy the port with something that is not a CodeWork server, so the managed
		// server's bind fails and the health probe never succeeds.
		const blocker = spawn(
			process.execPath,
			["-e", "require('node:net').createServer().listen(7605, '127.0.0.1', () => console.log('listening'))"],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		servers.push(blocker);
		await new Promise((resolve) => blocker.stdout.once("data", resolve));

		const result = spawnSync(
			process.execPath,
			["--conditions=development", cli, "--home", dir, "tui", "--port", "7605"],
			{
				encoding: "utf8",
				env: { ...process.env, HOME: dir, CODEWORK_MODELS_FILE: models, CODEWORK_TUI_BIN: binary },
				timeout: 30_000,
			},
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("could not start a CodeWork server on 127.0.0.1:7605");
		// The server's own reason comes back from its log, without waiting out the start timeout.
		expect(result.stderr).toContain("EADDRINUSE");
		expect(result.stderr).toContain(`log: ${join(dir, "log", "server.log")}`);
	}, 40_000);

	it("restarts the server on the same endpoint if it dies while the TUI runs", async () => {
		const dir = home();
		const binary = report(dir);
		const child = hold(dir, { CODEWORK_TUI_BIN: binary, FAKE_TUI_HOLD: "1" }, ["tui", "--port", "7606"]);
		await readReport(child);
		const first = registration(dir);

		process.kill(first.pid, "SIGKILL");
		await waitFor(() => {
			try {
				return registration(dir).pid !== first.pid;
			} catch {
				return false;
			}
		});

		const second = registration(dir);
		expect(second.url).toBe(first.url);
		// `status` only names a server that answers as the registrant: the replacement serves.
		expect(service(dir, "status")).toBe(`${first.url}\n`);
		expect(child.exitCode).toBeNull();
	}, 40_000);
});

describe("codework service", () => {
	it("adopts one server when two callers start it at once", async () => {
		const dir = home();
		const start = () =>
			new Promise<string>((resolve) => {
				const child = spawnCli(dir, {}, ["service", "start", "--port", "7608"]);
				let stdout = "";
				child.stdout.on("data", (chunk) => (stdout += String(chunk)));
				child.once("exit", () => resolve(stdout));
			});

		const [a, b] = await Promise.all([start(), start()]);
		expect(a).toBe("ws://127.0.0.1:7608/rpc/v1\n");
		expect(b).toBe(a);
		expect(service(dir, "status")).toBe(a);
	}, 60_000);

	it("stops a server whose registration another server took over", async () => {
		const dir = home();
		service(dir, "start", "--port", "7609");
		const first = registration(dir).pid;
		// A second server for the same home on another port files its own registration.
		const other = spawnCli(dir, {}, ["serve", "--port", "7610"]);
		servers.push(other);
		await waitFor(() => registration(dir).pid !== first);

		await waitFor(() => dead(first), 15_000);
		expect(service(dir, "status")).toBe("ws://127.0.0.1:7610/rpc/v1\n");
	}, 60_000);

	it("starts, reuses, restarts and stops the background server", async () => {
		const dir = home();
		const steps: Array<{ readonly command: string; readonly stdout: string; readonly registered: boolean }> = [];
		const step = (...args: ReadonlyArray<string>) => {
			const stdout = service(dir, ...args);
			steps.push({ command: args.join(" "), stdout, registered: existsSync(join(dir, "service.json")) });
			return stdout;
		};

		step("status");
		step("start", "--port", "7607");
		const started = registration(dir).pid;
		step("status");
		step("start", "--port", "7607");
		// A second start adopts the running server rather than replacing it.
		expect(registration(dir).pid).toBe(started);
		step("restart", "--port", "7607");
		expect(registration(dir).pid).not.toBe(started);
		expect(dead(started)).toBe(true);
		const restarted = registration(dir).pid;
		step("stop");
		step("status");

		expect(dead(restarted)).toBe(true);
		await expect(JSON.stringify(steps, null, "\t") + "\n").toMatchFileSnapshot(
			"./__artifacts__/service.lifecycle.json",
		);
	}, 60_000);
});
