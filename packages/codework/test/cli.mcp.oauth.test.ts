/* @effect-diagnostics nodeBuiltinImport:off -- this suite writes its home and settings with node:fs. */
/* @effect-diagnostics globalFetch:off -- the suite plays the browser with plain fetch. */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vite-plus/test";
import { models, provider, runCli, type ToolCall, writeSettings } from "./fixtures/cli.ts";
// @ts-expect-error -- a plain ESM fixture without types.
import { start } from "./fixtures/mcp-oauth.mjs";

interface Fixture {
	readonly url: string;
	readonly state: {
		log: unknown[];
		access: Map<string, unknown>;
		refresh: string | undefined;
		afterList: "expire" | "revoke" | undefined;
		presented: Set<string>;
	};
	readonly close: () => Promise<void>;
}

type Stored = Record<
	string,
	{ tokens?: { access_token: string }; challenge?: { scope?: string; error?: string } } | undefined
>;

const AUTHORIZE = /http:\/\/127\.0\.0\.1:\d+\/authorize\S+/;

/** A home with `mcp.json` built from the fixture's URL, and the CLI commands a case runs in it. */
const setup = async (options: object, servers: (url: string) => Record<string, object>) => {
	const home = mkdtempSync(join(tmpdir(), "codework-cli-mcp-oauth-"));
	onTestFinished(() => rmSync(home, { recursive: true, force: true }));
	const project = join(home, "project");
	const settings = join(home, "settings");
	mkdirSync(project);
	mkdirSync(settings);
	const server = (await start({ keyedToken: "provider-key", ...options })) as Fixture;
	onTestFinished(() => server.close());
	let calls: ReadonlyArray<ToolCall> = [];
	const fake = await provider(() => calls);
	writeSettings(settings, fake.url);
	const configure = (next: Record<string, object>) =>
		writeFileSync(join(settings, "mcp.json"), JSON.stringify({ mcpServers: next }));
	configure(servers(server.url));
	// Read by each command as it starts, so a case may change it between commands.
	const env = { ...process.env, HOME: home, CODEWORK_MODELS_FILE: models, OPENAI_API_KEY: "provider-key" };
	const shared = ["--home", home, "--database", ":memory:", "--user-config-dir", settings];
	const port = new URL(server.url).port;
	const normalise = (text: string) =>
		text
			.replaceAll(server.url, "<fixture>")
			.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
			.replaceAll(home, "<home>")
			.replaceAll(port, "<port>");
	const file = join(home, "mcpauth.json");
	const stored = (): Stored => JSON.parse(readFileSync(file, "utf8")) as Stored;

	const run = async (prompt: string, next: ReadonlyArray<ToolCall>) => {
		calls = next;
		const result = await runCli([...shared, "run", prompt], { cwd: project, env });
		expect(result.status, result.stderr).toBe(0);
		const request = fake.requests.findLast((one) => one.messages.some((message) => message.content === prompt));
		const declared = (request?.tools ?? [])
			.map((tool) => tool.function.name)
			.filter((name) => name.startsWith("mcp__"));
		return { declared, answer: normalise(result.stdout.trim()) };
	};

	/**
	 * `codework mcp login`, playing the browser: follow the authorization URL to the loopback
	 * callback, with `before` and `after` sent the callback URL around that request. `cancel`
	 * interrupts the CLI instead, once it shows the URL. `paste` runs it in a terminal and types the
	 * callback URL in when asked, never requesting it.
	 */
	const login = async (
		name: string,
		options: {
			readonly cancel?: boolean;
			readonly paste?: boolean;
			readonly before?: (callback: string) => Promise<void>;
			readonly after?: (callback: string) => Promise<void>;
		} = {},
	) => {
		let page: number | undefined;
		let callback: string | undefined;
		let browsing: Promise<void> | undefined;
		let child: { kill: (signal: NodeJS.Signals) => void; stdin: NodeJS.WritableStream } | undefined;
		const browse = (text: string) => {
			const url = AUTHORIZE.exec(text)?.[0];
			if (url === undefined || browsing !== undefined || (options.paste && !text.includes("redirected to:"))) return;
			browsing = (async () => {
				const approved = await fetch(url, { redirect: "manual" });
				callback = approved.headers.get("location") ?? undefined;
				if (options.cancel) return child?.kill("SIGINT");
				if (callback === undefined) return;
				if (options.paste) return void child?.stdin.write(`${callback}\n`);
				await options.before?.(callback);
				page = (await fetch(callback)).status;
				await options.after?.(callback);
			})();
		};
		const result = await runCli([...shared, "mcp", "login", name, "--browser=false"], {
			cwd: project,
			env,
			tty: options.paste ?? false,
			onSpawn: (spawned) => {
				child = spawned;
			},
			onStdout: browse,
			onStderr: browse,
		});
		await browsing;
		// In a terminal both streams arrive as one.
		const lines = (options.paste ? result.stdout : result.stderr).trim().split(/\r?\n/);
		return {
			status: result.status,
			stdout: result.stdout,
			// The last line says why a sign-in failed. An interrupted one says nothing, and leaves the
			// authorization URL as its last line.
			error: result.status === 0 || AUTHORIZE.test(lines.at(-1) ?? "") ? undefined : normalise(lines.at(-1) ?? ""),
			page,
			callback,
		};
	};

	return {
		server,
		env,
		configure,
		run,
		login,
		stored,
		file,
		normalise,
		cli: (args: ReadonlyArray<string>) => runCli([...shared, ...args], { cwd: project, env }),
	};
};

const whoami = (server: string): ToolCall => ({ name: `mcp__${server}__whoami`, arguments: {} });

it("codework mcp login signs in to an OAuth server; runs refresh its tokens and report a revoked sign-in", async () => {
	const { server, run, login, stored, file, normalise, cli } = await setup({}, (url) => ({
		secure: { url: `${url}/mcp` },
		// The same URL under another name is another account, and stays signed out.
		twin: { url: `${url}/mcp` },
		// A provider's API key as the bearer, read from the environment like a model call reads it.
		keyed: { url: `${url}/keyed`, auth: { provider: "openai" } },
	}));

	// Before sign-in the OAuth servers offer no tools; the provider-keyed one works.
	const before = await run("Before sign-in.", [whoami("keyed")]);
	expect(before.declared).toEqual(["mcp__keyed__whoami"]);
	expect(before.answer).toContain("called with provider-key");

	const signedIn = await login("secure");
	expect(signedIn.status, signedIn.error).toBe(0);
	expect(signedIn.stdout).toBe('Signed in to MCP server "secure" (1 tool).\n');
	expect(signedIn.page).toBe(200);
	expect(stored()[`mcp__secure|${server.url}/mcp`]?.tokens?.access_token).toBe("access-1");
	expect(statSync(file).mode & 0o777).toBe(0o600);

	// Signed in already: no browser, and the tools it offers.
	const again = await login("secure");
	expect(again.stdout).toBe('Already signed in to MCP server "secure" (1 tool).\n');
	expect(again.callback).toBeUndefined();

	const named = await run("Both names.", [whoami("secure")]);
	expect(named.declared).toEqual(["mcp__secure__whoami", "mcp__keyed__whoami"]);

	// Two processes find the same token rejected: the refresh lock lets one refresh, and the other
	// uses what it saved.
	server.state.access.clear();
	const [first, second] = await Promise.all([
		run("Process one.", [whoami("secure")]),
		run("Process two.", [whoami("secure")]),
	]);
	expect([first.answer, second.answer]).toEqual([
		"Tool said: called with access-2",
		"Tool said: called with access-2",
	]);

	// The access token expires mid-run: both calls get a 401 and share one refresh.
	server.state.afterList = "expire";
	const refreshed = await run("After expiry.", [whoami("secure"), whoami("secure")]);
	expect(refreshed.answer).toBe("Tool said: called with access-3 | called with access-3");

	// Every token revoked: the refresh fails, and the model is told how the user signs in again.
	server.state.afterList = "revoke";
	const revoked = await run("After revocation.", [whoami("secure")]);
	expect(revoked.answer).toContain('MCP server "secure" requires sign-in. Run "codework mcp login secure".');

	const logout = await cli(["mcp", "logout", "secure"]);
	expect(logout.status, logout.stderr).toBe(0);
	expect(stored()[`mcp__secure|${server.url}/mcp`]).toBeUndefined();

	await expect(
		`${JSON.stringify(
			{
				before,
				login: { stdout: signedIn.stdout, page: signedIn.page },
				again: again.stdout,
				named,
				processes: [first, second],
				refreshed,
				revoked,
				logout: logout.stdout,
				server: JSON.parse(normalise(JSON.stringify(server.state.log))),
			},
			null,
			"\t",
		)}\n`,
	).toMatchFileSnapshot("./__artifacts__/cli.mcp.oauth.json");
}, 120_000);

it("a call needing more scope asks for sign-in, and the next login requests that scope on top of the granted one", async () => {
	const { server, run, login, stored, normalise } = await setup({ requireScope: "admin" }, (url) => ({
		secure: { url: `${url}/mcp` },
	}));
	const first = await login("secure");
	expect(first.status, first.error).toBe(0);

	const refused = await run("Needs more scope.", [whoami("secure")]);
	expect(refused.answer).toContain('MCP server "secure" requires sign-in. Run "codework mcp login secure".');
	const challenge = stored()[`mcp__secure|${server.url}/mcp`]?.challenge;
	expect(challenge).toMatchObject({ scope: "tools admin", error: "insufficient_scope" });

	// The connection itself still works, so only the stored challenge makes this sign in again.
	const stepUp = await login("secure");
	expect(stepUp.stdout).toBe('Signed in to MCP server "secure" (1 tool).\n');
	expect(stored()[`mcp__secure|${server.url}/mcp`]?.challenge).toBeUndefined();

	const allowed = await run("With more scope.", [whoami("secure")]);
	expect(allowed.answer).toBe("Tool said: called with access-2");

	await expect(
		`${JSON.stringify(
			{
				refused,
				challenge: JSON.parse(normalise(JSON.stringify(challenge))),
				stepUp: stepUp.stdout,
				allowed,
				server: JSON.parse(normalise(JSON.stringify(server.state.log))),
			},
			null,
			"\t",
		)}\n`,
	).toMatchFileSnapshot("./__artifacts__/cli.mcp.oauth.scope.json");
}, 120_000);

it("a refresh refused because another process signed in meanwhile keeps that process's tokens", async () => {
	let beforeToken: (() => void) | undefined;
	const { server, run, login, stored, file, normalise } = await setup(
		{ beforeToken: async () => beforeToken?.() },
		(url) => ({ secure: { url: `${url}/mcp` } }),
	);
	const signedIn = await login("secure");
	expect(signedIn.status, signedIn.error).toBe(0);
	const id = `mcp__secure|${server.url}/mcp`;

	// While the run's refresh waits for the token endpoint, another process signs in again: it stores
	// new tokens under the file's lock, and the server revokes the refresh token the run presented.
	beforeToken = () => {
		beforeToken = undefined;
		const lock = `${file}.lock`;
		mkdirSync(lock);
		const all = stored();
		const tokens = {
			access_token: "access-other",
			token_type: "Bearer",
			expires_in: 3600,
			refresh_token: "refresh-other",
		};
		all[id] = { ...all[id], tokens };
		writeFileSync(`${file}.other.tmp`, JSON.stringify(all), { mode: 0o600 });
		renameSync(`${file}.other.tmp`, file);
		rmdirSync(lock);
		server.state.access.set("access-other", undefined);
		server.state.refresh = "refresh-other";
	};
	server.state.access.clear();
	const refused = await run("Signed in elsewhere.", [whoami("secure")]);
	// The refused refresh drops nothing it did not present, so the run carries on with those tokens.
	expect(refused.answer).toBe("Tool said: called with access-2");
	expect(stored()[id]?.tokens?.access_token).toBe("access-2");

	await expect(
		`${JSON.stringify(
			{
				refused,
				stored: JSON.parse(normalise(JSON.stringify(stored()[id]?.tokens))),
				server: JSON.parse(normalise(JSON.stringify(server.state.log))),
			},
			null,
			"\t",
		)}\n`,
	).toMatchFileSnapshot("./__artifacts__/cli.mcp.oauth.invalidate.json");
}, 120_000);

it("codework mcp login accepts what a sign-in may trust and refuses the rest", async () => {
	const cases: Record<string, unknown> = {};
	const attempt = async (
		name: string,
		options: object,
		extra: (url: string) => object = () => ({}),
		cancel = false,
	) => {
		const { login, stored, file, server } = await setup(options, (url) => ({
			secure: { url: `${url}/mcp`, ...extra(url) },
		}));
		const result = await login("secure", { cancel });
		let tokens = false;
		try {
			tokens = stored()[`mcp__secure|${server.url}/mcp`]?.tokens !== undefined;
		} catch {
			// No file: nothing was ever stored.
		}
		cases[name] = { status: result.status === 0 ? "signed in" : "refused", error: result.error, tokens };
		return { ...result, file, tokens };
	};

	// Authorization server metadata from `oauth.authServerMetadataUrl`, when discovery finds none.
	const configured = await attempt("configured metadata", { metadata: false }, (url) => ({
		oauth: { authServerMetadataUrl: `${url}/custom/metadata` },
	}));
	expect(configured.status, configured.error).toBe(0);
	// A server that names itself in the authorization response (RFC 9207), as Linear does.
	expect((await attempt("iss from the issuer", { iss: "self" })).status).toBe(0);
	// Metadata that names another issuer than the one discovered (RFC 8414).
	expect((await attempt("metadata from another issuer", { issuer: "http://127.0.0.1:1" })).status).not.toBe(0);
	// A `file:` authorization endpoint would launch a local program.
	expect(
		(await attempt("file: authorization endpoint", { authorizationEndpoint: "file:///etc/passwd" })).status,
	).not.toBe(0);
	// `iss` with nothing discovered to check it against.
	expect((await attempt("iss without metadata", { metadata: false, iss: "self" })).status).not.toBe(0);
	// `iss` naming another authorization server.
	expect((await attempt("iss from another server", { iss: "https://evil.example" })).status).not.toBe(0);
	expect((await attempt("rejected code", { rejectCode: true })).status).not.toBe(0);

	// Interrupted while waiting for the browser: nothing stored, and the callback no longer listens.
	const cancelled = await attempt("cancelled", {}, () => ({}), true);
	expect(cancelled.status).not.toBe(0);
	expect(cancelled.tokens).toBe(false);
	await expect(fetch(cancelled.callback!)).rejects.toThrow();

	await expect(`${JSON.stringify(cases, null, "\t")}\n`).toMatchFileSnapshot(
		"./__artifacts__/cli.mcp.oauth.cases.json",
	);
}, 180_000);

it("codework mcp login and logout refuse servers that do not sign in with OAuth", async () => {
	const { cli } = await setup({}, (url) => ({
		secure: { url: `${url}/mcp` },
		local: { command: process.execPath, args: ["--version"] },
		keyed: { url: `${url}/keyed`, auth: { provider: "openai" } },
		token: { url: `${url}/mcp`, headers: { Authorization: "Bearer mine" } },
	}));
	const outcomes: Record<string, string> = {};
	for (const [label, args] of [
		["unknown server", ["mcp", "login", "missing"]],
		["stdio server", ["mcp", "login", "local"]],
		["provider credential", ["mcp", "login", "keyed"]],
		["own Authorization header", ["mcp", "login", "token"]],
		["logout of an unknown server", ["mcp", "logout", "missing"]],
		["logout of a provider-keyed server", ["mcp", "logout", "keyed"]],
		["logout without a sign-in", ["mcp", "logout", "secure"]],
	] as const) {
		const result = await cli(args);
		outcomes[label] = (result.status === 0 ? result.stdout : result.stderr).trim().split("\n").at(-1) ?? "";
	}
	await expect(`${JSON.stringify(outcomes, null, "\t")}\n`).toMatchFileSnapshot(
		"./__artifacts__/cli.mcp.oauth.refused.json",
	);
}, 120_000);

it("a provider-keyed server that refuses the key asks for the provider's sign-in, and connects with the right key", async () => {
	const { server, env, cli, run } = await setup({}, (url) => ({
		keyed: { url: `${url}/keyed`, auth: { provider: "openai" } },
	}));
	const status = async () => {
		const listed = await cli(["mcp", "list", "--json"]);
		const [report] = (JSON.parse(listed.stdout) as { servers: Array<{ state: string; error?: string }> }).servers;
		return { exit: listed.status, state: report?.state, error: report?.error };
	};

	env.OPENAI_API_KEY = "wrong-key";
	const refused = await status();
	expect(refused).toEqual({
		exit: 1,
		state: "authenticate",
		error: 'MCP server "keyed" refused the credential of provider "openai". Sign in to it with "codework auth login", or set its API key.',
	});
	const asked = await run("Wrong key.", [whoami("keyed")]);
	expect(asked.declared).toEqual([]);

	env.OPENAI_API_KEY = "provider-key";
	const accepted = await status();
	expect(accepted).toEqual({ exit: 0, state: "connected", error: undefined });
	const called = await run("Right key.", [whoami("keyed")]);
	expect(called.answer).toBe("Tool said: called with provider-key");
	expect([...server.state.presented]).toEqual(["wrong-key", "provider-key"]);

	await expect(
		`${JSON.stringify({ refused, asked, accepted, called, presented: [...server.state.presented] }, null, "\t")}\n`,
	).toMatchFileSnapshot("./__artifacts__/cli.mcp.oauth.provider.json");
}, 120_000);

it("the sign-in callback ignores stray and replayed requests, and a denied authorization fails the login", async () => {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	// The token exchange waits until the replay is sent, so the callback is still listening for it.
	const { server, login, stored, normalise } = await setup({ beforeToken: () => held }, (url) => ({
		secure: { url: `${url}/mcp` },
	}));
	const stray: Record<string, number> = {};
	const send = async (label: string, url: string) => {
		stray[label] = (await fetch(url)).status;
	};
	const signedIn = await login("secure", {
		before: async (callback) => {
			const real = new URL(callback);
			const at = (path: string, query: string) => `${real.origin}${path}${query}`;
			const code = real.searchParams.get("code");
			await send("wrong path", at("/elsewhere", real.search));
			await send("missing state", at(real.pathname, `?code=${code}`));
			await send("wrong state", at(real.pathname, `?code=${code}&state=wrong`));
			await send("error with a wrong state", at(real.pathname, "?error=access_denied&state=wrong"));
			await send("no OAuth parameters", at(real.pathname, ""));
		},
		after: async (callback) => {
			await send("replay", callback);
			release();
		},
	});
	expect(signedIn.status, signedIn.error).toBe(0);
	expect(signedIn.page).toBe(200);
	expect(stray).toEqual({
		"wrong path": 404,
		"missing state": 400,
		"wrong state": 400,
		"error with a wrong state": 400,
		"no OAuth parameters": 400,
		replay: 400,
	});
	expect(stored()[`mcp__secure|${server.url}/mcp`]?.tokens?.access_token).toBe("access-1");

	const denied = await setup({ deny: "The user refused access" }, (url) => ({ secure: { url: `${url}/mcp` } }));
	const refused = await denied.login("secure");
	expect(refused.status).not.toBe(0);
	expect(refused.error).toContain("The user refused access");
	expect(denied.server.state.log).not.toContainEqual(expect.objectContaining({ token: "authorization_code" }));

	await expect(
		`${JSON.stringify(
			{
				stray,
				signedIn: { stdout: signedIn.stdout, page: signedIn.page },
				server: JSON.parse(normalise(JSON.stringify(server.state.log))),
				denied: { error: denied.normalise(refused.error ?? ""), page: refused.page },
			},
			null,
			"\t",
		)}\n`,
	).toMatchFileSnapshot("./__artifacts__/cli.mcp.oauth.callback.json");
}, 120_000);

it("codework mcp login signs in with the redirect URL pasted into the terminal", async () => {
	const { server, login, stored, normalise } = await setup({}, (url) => ({ secure: { url: `${url}/mcp` } }));
	const pasted = await login("secure", { paste: true });
	expect(pasted.status, pasted.error).toBe(0);
	expect(pasted.page).toBeUndefined();
	const outcome = pasted.stdout.split(/\r?\n/).find((line) => line.startsWith("Signed in"));
	expect(outcome).toBe('Signed in to MCP server "secure" (1 tool).');
	const access = stored()[`mcp__secure|${server.url}/mcp`]?.tokens?.access_token;
	expect(access).toBe("access-1");

	await expect(
		`${JSON.stringify({ outcome, access, server: JSON.parse(normalise(JSON.stringify(server.state.log))) }, null, "\t")}\n`,
	).toMatchFileSnapshot("./__artifacts__/cli.mcp.oauth.paste.json");
}, 120_000);

it("tokens stay with the server URL they were issued for when the server moves", async () => {
	const { server, login, configure, cli, run, stored, normalise } = await setup({}, (url) => ({
		secure: { url: `${url}/mcp` },
	}));
	const signedIn = await login("secure");
	expect(signedIn.status, signedIn.error).toBe(0);

	const moved = (await start({})) as Fixture;
	onTestFinished(() => moved.close());
	configure({ secure: { url: `${moved.url}/mcp` } });
	const listed = await cli(["mcp", "list", "--json"]);
	const [report] = (JSON.parse(listed.stdout) as { servers: Array<{ state: string; error?: string }> }).servers;
	expect(report).toMatchObject({
		state: "authenticate",
		error: 'MCP server "secure" requires sign-in. Run "codework mcp login secure".',
	});
	const asked = await run("Moved.", [whoami("secure")]);
	expect(asked.declared).toEqual([]);
	expect([...moved.state.presented]).toEqual([]);
	// The moved server's challenge is remembered under its own URL, with no tokens.
	expect(stored()[`mcp__secure|${moved.url}/mcp`]?.tokens).toBeUndefined();
	const entries = Object.fromEntries(
		Object.entries(stored()).map(([key, entry]) => [
			normalise(key.replace(moved.url, "<moved>")),
			{ access: entry?.tokens?.access_token, challenge: entry?.challenge?.error },
		]),
	);

	await expect(
		`${JSON.stringify(
			{
				moved: { state: report?.state, error: report?.error },
				asked,
				presented: { first: [...server.state.presented], moved: [...moved.state.presented] },
				stored: entries,
			},
			null,
			"\t",
		)}\n`,
	).toMatchFileSnapshot("./__artifacts__/cli.mcp.oauth.moved.json");
}, 120_000);
