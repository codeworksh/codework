/* @effect-diagnostics nodeBuiltinImport:off -- this suite writes its home and settings with node:fs. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vite-plus/test";
import { models, provider, runCli, writeSettings } from "./fixtures/cli.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url));

it("codework run calls a tool of a stdio MCP server from mcp.json, and stops the server on exit", async () => {
	const home = mkdtempSync(join(tmpdir(), "codework-cli-mcp-"));
	onTestFinished(() => rmSync(home, { recursive: true, force: true }));
	const project = join(home, "project");
	const settings = join(home, "settings");
	mkdirSync(project);
	mkdirSync(settings);
	const fake = await provider(() => [{ name: "mcp__fixture__echo", arguments: { text: "from the cli" } }]);
	writeSettings(settings, fake.url);
	// `mcp.json` sits next to the user settings the run reads.
	writeFileSync(
		join(settings, "mcp.json"),
		JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture] } } }),
	);

	const result = await runCli(
		["--home", home, "--database", ":memory:", "--user-config-dir", settings, "run", "Echo something."],
		{ cwd: project, env: { ...process.env, HOME: home, CODEWORK_MODELS_FILE: models } },
	);
	expect(result.status, result.stderr).toBe(0);

	const answer = /echo: from the cli \(pid (\d+), cwd ([^)]+)\)/.exec(result.stdout);
	expect(answer, result.stdout).not.toBeNull();
	const [, pid, cwd] = answer!;
	// The server ran on this machine, in the session's directory, and is gone once the CLI exits.
	expect(cwd).toBe(realpathSync(project));
	expect(() => process.kill(Number(pid), 0)).toThrow();

	const declared = fake.requests[0]?.tools?.find((tool) => tool.function.name === "mcp__fixture__echo");
	await expect(
		`${JSON.stringify(
			{
				requests: fake.requests.length,
				declared: declared?.function,
				answer: answer![0].replace(pid!, "<pid>").replace(cwd!, "<project>"),
			},
			null,
			"\t",
		)}\n`,
	).toMatchFileSnapshot("./__artifacts__/cli.mcp.json");
}, 60_000);
