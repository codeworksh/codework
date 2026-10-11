/* @effect-diagnostics nodeBuiltinImport:off -- this suite spawns the CLI and a fake TUI as child processes. */
/* @effect-diagnostics globalTimers:off -- polling a spawned process from the test host is not Effect code. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
			"}) + \"\\n\");",
			"process.exit(Number(process.env.FAKE_TUI_EXIT ?? 0));",
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
	for (const server of servers.splice(0)) server.kill("SIGKILL");
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
			const line = buffer.split("\n")[0];
			if (line !== undefined && line.startsWith("{")) {
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
			["--conditions=development", cli, "--home", home(), "tui", "--server", "ws://127.0.0.1:1/rpc"],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("belong on codework serve");
	});

	it("fails clearly when --server does not answer as a CodeWork server", () => {
		const result = spawnSync(
			process.execPath,
			["--conditions=development", cli, "tui", "--server", "ws://127.0.0.1:1/rpc"],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no CodeWork server answered at ws://127.0.0.1:1/rpc");
	});

	it("starts a managed server, registers it, and launches the TUI against its endpoint", async () => {
		const dir = home();
		const binary = report(dir);
		const child = hold(dir, { CODEWORK_TUI_BIN: binary }, ["tui", "--port", "7601", "hello", "world"]);

		const endpoint = join(dir, "service.json");
		await waitFor(() => existsSync(endpoint));
		const registration = JSON.parse(readFileSync(endpoint, "utf8")) as { url: string; port: number; pid: number };
		expect(registration.port).toBe(7601);
		expect(registration.url).toBe("ws://127.0.0.1:7601/rpc");
		expect(registration.pid).toBeGreaterThan(0);

		const message = await readReport(child);
		expect(message.server).toBe("ws://127.0.0.1:7601/rpc");
		expect(message.home).toBe(dir);
		// Positional arguments after the command reach the binary untouched.
		expect(message.args).toEqual(["hello", "world"]);

		child.kill("SIGKILL");
	}, 30_000);

	it("reuses a registered server instead of starting another", async () => {
		const dir = home();
		const binary = report(dir);
		const first = hold(dir, { CODEWORK_TUI_BIN: binary }, ["tui", "--port", "7602"]);
		const firstMessage = await readReport(first);
		expect(firstMessage.server).toBe("ws://127.0.0.1:7602/rpc");
		first.kill("SIGKILL");
		// Let the first CLI release the port before the second attaches.
		await new Promise((resolve) => setTimeout(resolve, 300));

		const second = spawnCli(dir, { CODEWORK_TUI_BIN: binary }, ["tui", "--port", "7602"]);
		const secondMessage = await readReport(second);
		expect(secondMessage.server).toBe("ws://127.0.0.1:7602/rpc");
		// No "Starting CodeWork server" on the reuse path: the same registration was adopted.
		expect(second.stderr.read()).toBeNull();
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
		const blocker = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(7605, '127.0.0.1')"], {
			stdio: "ignore",
		});
		servers.push(blocker);
		await new Promise((resolve) => setTimeout(resolve, 500));

		const result = spawnSync(process.execPath, ["--conditions=development", cli, "--home", dir, "tui", "--port", "7605"], {
			encoding: "utf8",
			env: { ...process.env, HOME: dir, CODEWORK_MODELS_FILE: models, CODEWORK_TUI_BIN: binary },
			timeout: 30_000,
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("could not start a CodeWork server");
	}, 40_000);
});
