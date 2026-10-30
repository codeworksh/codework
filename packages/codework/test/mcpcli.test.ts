/* @effect-diagnostics nodeBuiltinImport:off -- this suite writes its home and project with node:fs. */
/* @effect-diagnostics preferSchemaOverJson:off -- the artifact is plain JSON. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vite-plus/test";
import { runCli } from "./fixtures/cli.ts";
// @ts-expect-error -- a plain ESM fixture without types.
import { start } from "./fixtures/mcp-oauth.mjs";

const echo = fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url));

it("codework mcp add, remove and list edit both mcp.json files in place and report every server", async () => {
	const home = mkdtempSync(join(tmpdir(), "codework-mcpcli-"));
	onTestFinished(() => rmSync(home, { recursive: true, force: true }));
	const project = join(home, "project");
	const nested = join(project, "packages", "app");
	mkdirSync(join(project, ".codework"), { recursive: true });
	mkdirSync(nested, { recursive: true });
	const oauth = (await start({})) as { readonly url: string; readonly close: () => Promise<void> };
	onTestFinished(() => oauth.close());

	const userFile = join(home, "mcp.json");
	const projectFile = join(project, ".codework", "mcp.json");
	// Hand-written files: comments, an unrelated key, and an entry each command must leave alone.
	writeFileSync(
		userFile,
		'{\n\t// Servers for every project.\n\t"$schema": "https://example.com/mcp.json",\n\t"mcpServers": {\n\t\t"old": { "command": "old-server" }\n\t}\n}\n',
	);
	writeFileSync(
		projectFile,
		'{\n\t"mcpServers": {\n\t\t// Hide one tool of the user server here.\n\t\t"echo": { "toolExposure": { "echo": "hidden" } },\n\t\t"broken": { "url": 42 }\n\t}\n}\n',
	);

	const env = { ...process.env, HOME: home };
	// The project root is found by its real path, `/private/var/...` on macOS.
	const real = realpathSync(home);
	const normalise = (text: string) =>
		text
			.replaceAll(oauth.url, "<oauth>")
			.replaceAll(echo, "<echo>")
			.replaceAll(process.execPath, "<node>")
			.replaceAll(real, "<home>")
			.replaceAll(home, "<home>");
	// Run from a subdirectory: the project is the nearest `.codework` above it.
	const cli = async (...args: ReadonlyArray<string>) => {
		const result = await runCli(["--home", home, ...args], { cwd: nested, env });
		return { status: result.status, stdout: normalise(result.stdout), stderr: normalise(result.stderr) };
	};
	const files = () => ({
		user: normalise(readFileSync(userFile, "utf8")),
		project: normalise(readFileSync(projectFile, "utf8")),
	});

	const added = {
		stdio: await cli("mcp", "add", "echo", "--env", "GREETING=hi", "--", process.execPath, echo),
		// Connects, with tools the SDK rejects skipped.
		partial: await cli("mcp", "add", "partial", "--env", "E2E_SKIPPED=1", "--", process.execPath, echo),
		http: await cli("mcp", "add", "secure", "--url", `${oauth.url}/mcp`, "--oauth-client-name", "CodeWork test"),
		crashing: await cli(
			"mcp",
			"add",
			"-l",
			"crash",
			"--",
			process.execPath,
			"-e",
			"console.error('cannot start: missing config'); process.exit(3)",
		),
		replaced: await cli("mcp", "add", "old", "--exposure", "hidden", "--", "old-server", "--verbose"),
	};
	const rejected = {
		both: await cli("mcp", "add", "x", "--url", "https://example.com/mcp", "--", "x"),
		neither: await cli("mcp", "add", "x"),
		misplaced: await cli("mcp", "add", "x", "--url", "https://example.com/mcp", "--env", "A=1"),
		invalid: await cli("mcp", "add", "x", "--url", "ftp://example.com"),
	};
	for (const result of Object.values(added)) expect(result.status, result.stderr).toBe(0);
	for (const result of Object.values(rejected)) expect(result.status).toBe(1);
	const edited = files();

	// One server per state: connected, needing sign-in, failed, plus an invalid entry.
	const failing = { text: await cli("mcp", "list"), json: await cli("mcp", "list", "--json") };
	expect(failing.text.status).toBe(1);
	expect(failing.json.status).toBe(1);

	const removed = {
		user: await cli("mcp", "remove", "old"),
		project: await cli("mcp", "remove", "--local", "crash"),
		invalid: await cli("mcp", "remove", "-l", "broken"),
		otherFile: await cli("mcp", "remove", "-l", "secure"),
		missing: await cli("mcp", "remove", "nothing"),
		// It still needs sign-in; without it, every enabled server connects.
		secure: await cli("mcp", "remove", "secure"),
	};
	expect(removed.otherFile.status).toBe(1);
	expect(removed.missing.status).toBe(1);
	expect(removed.secure.status).toBe(0);
	const passing = await cli("mcp", "list");
	expect(passing.status, passing.stdout).toBe(0);

	await expect(
		`${JSON.stringify(
			{
				added,
				rejected,
				edited,
				list: { text: failing.text, json: JSON.parse(failing.json.stdout) },
				removed,
				passing,
				files: files(),
			},
			null,
			"\t",
		)}\n`,
	).toMatchFileSnapshot("./__artifacts__/mcpcli.json");
}, 120_000);
