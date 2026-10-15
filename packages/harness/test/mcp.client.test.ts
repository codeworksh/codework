import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoggingMessageNotificationParams, OAuthClientProvider } from "@modelcontextprotocol/client";
import { Deferred, Effect, Exit, Fiber, Option, Ref, Scope } from "effect";
import { describe, expect, onTestFinished, vi } from "vite-plus/test";
import { McpClient } from "../src/mcp/client.ts";
import { McpContent } from "../src/mcp/content.ts";
import { McpLog } from "../src/mcp/log.ts";
import { McpOutput } from "../src/mcp/output.ts";
import { Process } from "../src/sandbox/utils/process.ts";
import { listen, raw, sdk } from "./fixtures/mcp/http.ts";
import { testEffect } from "./utils/effect.ts";

const { live: it } = testEffect(Process.host);

const fixtures = fileURLToPath(new URL("./fixtures/mcp/", import.meta.url));
const stdio = (fixture: string, env: Record<string, string> = {}): McpClient.Stdio => ({
	_tag: "Stdio",
	command: process.execPath,
	args: [`${fixtures}${fixture}`],
	env,
	cwd: fixtures,
});
/** Saved output stays on the host; the fixture servers offer no resources to link to. */
const content: McpContent.Options = { save: McpOutput.save, readable: false };
const http = (url: URL): McpClient.Http => ({ _tag: "Http", url, headers: {} });

/** Each scenario's observable outcome, written to the artifact by the last test. */
const summary: Record<string, unknown> = {};
/** Every key the scenarios record; the artifact test refuses to snapshot without all of them. */
const scenarios = [
	"cancel",
	"crash",
	"failedConnectSession",
	"frameLimit",
	"framing",
	"http400",
	"httpClose",
	"httpHappy",
	"httpRetries",
	"initializedTimeout",
	"invalidEntry",
	"logFile",
	"logRotation",
	"missingCwd",
	"noToolsCapability",
	"onClose",
	"onLog",
	"outputSchema",
	"processGroup",
	"progress",
	"refused",
	"resources",
	"retry",
	"retryCloseReason",
	"roots",
	"sessionExpired",
	"spawnFailure",
	"stderrGrandchild",
	"stdioHappy",
	"strictResources",
	"stubborn",
	"toolsPagination",
	"unadvertisedListChanged",
	"unauthorized",
];

const normalise = (message: string) =>
	message
		.replaceAll(fixtures, "<fixtures>/")
		.replaceAll(process.execPath, "<node>")
		.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
		.replace(/\b\d+(\.\d+)?\s?ms\b/g, "<ms>");

const failure = (error: { readonly _tag: string; readonly message: string }) => ({
	tag: error._tag,
	message: normalise(error.message),
});

const text = (result: { readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }> }) =>
	result.content?.[0]?.text ?? "";

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// Orphans are reaped by init shortly after their group dies.
const gone = (pids: ReadonlyArray<number>) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 50 && pids.some(alive); attempt++) yield* Effect.sleep("20 millis");
		return pids.filter(alive).length === 0;
	});

// Independent of the client's own cleanup, so a regression there cannot leak processes past the test.
const reap = (pids: ReadonlyArray<number>) =>
	Effect.sync(() => {
		for (const pid of pids)
			for (const target of [-pid, pid]) {
				try {
					process.kill(target, "SIGKILL");
				} catch {
					// already gone
				}
			}
	});

const logEntries: ReadonlyArray<LoggingMessageNotificationParams> = [
	{ level: "info", data: "first line\nsecond line" },
	{ level: "warning", logger: "db", data: { query: "select 1", ms: 3 } },
];

const tempDir = Effect.acquireRelease(
	Effect.sync(() => mkdtempSync(join(tmpdir(), "codework-mcp-log-"))),
	(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

describe("mcp client", () => {
	it(
		"stdio: connects, lists tools and converts every content kind",
		Effect.gen(function* () {
			const connection = yield* McpClient.connect({ server: "fixture", endpoint: stdio("server.mjs") });
			const tools = yield* connection.tools();
			const echo = yield* connection.callTool({ name: "echo", args: { text: "hi" } });
			const mixed = yield* connection.callTool({ name: "mixed" });
			const structured = yield* connection.callTool({ name: "structured" });
			const converted = {
				echo: yield* McpContent.fromResult("fixture", echo, content),
				mixed: yield* McpContent.fromResult("fixture", mixed, content),
				structured: yield* McpContent.fromResult("fixture", structured, content),
			};
			summary.stdioHappy = {
				serverInfo: connection.serverInfo,
				instructions: connection.instructions,
				tools: tools.map((tool) => tool.name),
				echo: converted.echo,
				mixed: converted.mixed.map((block) =>
					block.type === "text"
						? { ...block, text: block.text.replace(/saved to .+\]$/, "saved to <output>.bin]") }
						: block,
				),
				structured: converted.structured,
			};
			expect(connection.instructions).toBe("Use the echo tool.");
			expect(converted.echo).toEqual([{ type: "text", text: "hi" }]);
			const saved = /saved to (.+)\]$/.exec((converted.mixed[4] as { readonly text: string }).text)?.[1];
			expect(saved).toBeDefined();
			onTestFinished(() => rmSync(saved!, { force: true }));
			expect(yield* Effect.promise(() => readFile(saved!))).toEqual(Buffer.from([0, 1, 2]));
			expect(converted.mixed).toEqual([
				{ type: "text", text: "hello" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
				{ type: "text", text: "embedded notes" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
				{ type: "text", text: `[Binary resource file:///data.bin (unknown type, 3B) saved to ${saved}]` },
				{ type: "text", text: "[audio audio/wav omitted]" },
				{ type: "text", text: '[Resource file:///README.md "readme"]' },
			]);
			expect(converted.structured).toEqual([
				{ type: "text", text: JSON.stringify({ answer: 42, items: ["a", "b"] }, null, 2) },
			]);
		}),
	);

	it(
		"http: connects to a real streamable HTTP server and calls a tool",
		Effect.gen(function* () {
			const url = yield* listen(yield* Effect.promise(sdk));
			const connection = yield* McpClient.connect({ server: "http", endpoint: http(url) });
			const tools = yield* connection.tools();
			const echo = yield* connection.callTool({ name: "echo", args: { text: "over http" } });
			summary.httpHappy = {
				serverInfo: connection.serverInfo,
				tools: tools.map((tool) => tool.name),
				echo: yield* McpContent.fromResult("http", echo, content),
			};
			expect(text(echo)).toBe("over http");
		}),
	);

	it(
		"stdio: a crash mid-call fails the pending call with the exit code and stderr, and reports close",
		Effect.gen(function* () {
			const connection = yield* McpClient.connect({ server: "fixture", endpoint: stdio("server.mjs") });
			const closed = yield* Deferred.make<string>();
			connection.onClose((reason) => Deferred.succeed(closed, reason).pipe(Effect.asVoid));
			const error = yield* connection.callTool({ name: "crash" }).pipe(Effect.flip);
			const reason = yield* Deferred.await(closed).pipe(Effect.timeout("2 seconds"));
			summary.crash = { error: failure(error), method: "method" in error ? error.method : undefined, reason };
			expect(error._tag).toBe("Mcp.RequestError");
			expect(error.message).toContain("exited with code 3");
			expect(error.message).toContain("fatal: fixture crashed on purpose");
			expect(reason).toContain("connection closed");
		}),
	);

	it(
		"stdio: closing the scope kills the server and its grandchild",
		Effect.gen(function* () {
			const outer = yield* Effect.scope;
			const pids = yield* Effect.gen(function* () {
				const connection = yield* McpClient.connect({ server: "fixture", endpoint: stdio("server.mjs") });
				const spawned = JSON.parse(text(yield* connection.callTool({ name: "spawn" }))) as {
					readonly server: number;
					readonly grandchild: number;
				};
				yield* Scope.addFinalizer(outer, reap([spawned.server, spawned.grandchild]));
				expect(alive(spawned.server) && alive(spawned.grandchild)).toBe(true);
				return [spawned.server, spawned.grandchild];
			}).pipe(Effect.scoped);
			const killed = yield* gone(pids);
			summary.processGroup = { killed };
			expect(killed).toBe(true);
		}),
	);

	it(
		"stdio: a server ignoring SIGTERM is still killed within a bounded time",
		Effect.gen(function* () {
			const outer = yield* Effect.scope;
			const started = Date.now();
			const pids = yield* Effect.gen(function* () {
				const connection = yield* McpClient.connect({ server: "stubborn", endpoint: stdio("stubborn.mjs") });
				const spawned = JSON.parse(connection.instructions ?? "{}") as {
					readonly server: number;
					readonly grandchild: number;
				};
				yield* Scope.addFinalizer(outer, reap([spawned.server, spawned.grandchild]));
				return [spawned.server, spawned.grandchild];
			}).pipe(Effect.scoped);
			const elapsed = Date.now() - started;
			const killed = yield* gone(pids);
			summary.stubborn = { killed, boundedUnder8s: elapsed < 8_000 };
			expect(elapsed).toBeLessThan(8_000);
			expect(killed).toBe(true);
		}),
		15_000,
	);

	it(
		"stdio: a grandchild holding only stderr is killed when the server exits, before scope close",
		Effect.gen(function* () {
			const outer = yield* Effect.scope;
			const killed = yield* Effect.gen(function* () {
				const connection = yield* McpClient.connect({ server: "fixture", endpoint: stdio("server.mjs") });
				const closed = yield* Deferred.make<void>();
				connection.onClose(() => Deferred.succeed(closed, undefined).pipe(Effect.asVoid));
				const spawned = JSON.parse(text(yield* connection.callTool({ name: "stderr-child" }))) as {
					readonly server: number;
					readonly grandchild: number;
				};
				yield* Scope.addFinalizer(outer, reap([spawned.server, spawned.grandchild]));
				// The server exits on its own; its grandchild keeps the stderr pipe open. The group is killed
				// as soon as the connection notices the exit, while the connection's scope is still open: the
				// spawner's own release at scope close would hide a missing kill.
				yield* gone([spawned.server]);
				yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"));
				return yield* gone([spawned.grandchild]);
			}).pipe(Effect.scoped);
			summary.stderrGrandchild = { killed };
			expect(killed).toBe(true);
		}),
	);

	it(
		"stdio: skips an invalid JSON line and parses a CRLF-terminated message",
		Effect.gen(function* () {
			const connection = yield* McpClient.connect({ server: "fixture", endpoint: stdio("server.mjs") });
			const changed = yield* Deferred.make<void>();
			connection.onToolsChanged(Deferred.succeed(changed, undefined).pipe(Effect.asVoid));
			const framed = yield* connection.callTool({ name: "frame" });
			yield* Deferred.await(changed).pipe(Effect.timeout("2 seconds"));
			const after = yield* connection.callTool({ name: "echo", args: { text: "still alive" } });
			summary.framing = { framed: text(framed), toolsChanged: true, after: text(after) };
			expect(text(after)).toBe("still alive");
		}),
	);

	it(
		"stdio: progress keeps a long call alive past the request timeout; silence times out",
		Effect.gen(function* () {
			const connection = yield* McpClient.connect({
				server: "fixture",
				endpoint: stdio("server.mjs"),
				timeout: { request: "1 second" },
			});
			let updates = 0;
			const progressed = yield* connection.callTool({
				name: "progress",
				args: { ms: 2_000, every: 200 },
				onProgress: () => {
					updates++;
				},
			});
			const count = updates;
			const silent = yield* connection.callTool({ name: "slow", args: { ms: 2_000 } }).pipe(Effect.flip);
			summary.progress = { progressed: text(progressed), sawProgress: count > 0, silent: failure(silent) };
			expect(text(progressed)).toBe("progress done");
			expect(count).toBeGreaterThan(3);
			expect(silent._tag).toBe("Mcp.RequestError");
			expect(silent.message).toContain("timed out");
		}),
	);

	it(
		"stdio: interrupting a call cancels it on the server and keeps the connection usable",
		Effect.gen(function* () {
			const connection = yield* McpClient.connect({ server: "fixture", endpoint: stdio("server.mjs") });
			const entered = yield* Deferred.make<void>();
			const acknowledged = yield* Deferred.make<void>();
			connection.onLog((entry) =>
				entry.data === "hang cancelled"
					? Deferred.succeed(acknowledged, undefined).pipe(Effect.asVoid)
					: Effect.void,
			);
			const fiber = yield* connection
				.callTool({ name: "hang", onProgress: () => void Deferred.doneUnsafe(entered, Effect.void) })
				.pipe(Effect.forkChild);
			yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"));
			yield* Fiber.interrupt(fiber);
			yield* Deferred.await(acknowledged).pipe(Effect.timeout("2 seconds"));
			const report = JSON.parse(text(yield* connection.callTool({ name: "cancelled" }))) as {
				readonly cancelled: number;
			};
			const echo = yield* connection.callTool({ name: "echo", args: { text: "after cancel" } });
			summary.cancel = { cancelled: report.cancelled, after: text(echo) };
			expect(report.cancelled).toBe(1);
			expect(text(echo)).toBe("after cancel");
		}),
	);

	it(
		"http: a transient 503 on initialize is retried",
		Effect.gen(function* () {
			const server = raw({ failInitialize: 1 });
			const url = yield* listen(server.handler);
			const connection = yield* McpClient.connect({ server: "raw", endpoint: http(url) });
			const tools = yield* connection.tools();
			const initializes = server.seen.filter((entry) => entry === "POST initialize").length;
			summary.retry = { initializes, tools: tools.map((tool) => tool.name) };
			expect(initializes).toBe(2);
		}),
	);

	it(
		"http: a 404 for a known session fails with SessionExpiredError and reports once",
		Effect.gen(function* () {
			const server = raw();
			const url = yield* listen(server.handler);
			const expired = yield* Ref.make(0);
			const outcome = yield* Effect.gen(function* () {
				const connection = yield* McpClient.connect({ server: "raw", endpoint: http(url) });
				connection.onSessionExpired(Ref.update(expired, (count) => count + 1));
				server.forget = true;
				const first = yield* connection.tools().pipe(Effect.flip);
				const second = yield* connection.tools().pipe(Effect.flip);
				return [failure(first), failure(second)];
			}).pipe(Effect.scoped);
			yield* Effect.sleep("50 millis");
			const reported = yield* Ref.get(expired);
			const terminated = server.seen.includes("DELETE");
			summary.sessionExpired = { errors: outcome, reported, terminated };
			expect(outcome.map((error) => error.tag)).toEqual(["Mcp.SessionExpiredError", "Mcp.SessionExpiredError"]);
			expect(reported).toBe(1);
			expect(terminated).toBe(false);
		}),
	);

	it(
		"stdio: roots are served as file URIs only when passed",
		Effect.gen(function* () {
			const withRoots = yield* Effect.gen(function* () {
				const connection = yield* McpClient.connect({
					server: "fixture",
					endpoint: stdio("server.mjs"),
					roots: ["/workspace/project", "/srv/data dir"],
				});
				return {
					roots: JSON.parse(text(yield* connection.callTool({ name: "roots" }))) as unknown,
					capabilities: JSON.parse(text(yield* connection.callTool({ name: "capabilities" }))) as unknown,
				};
			}).pipe(Effect.scoped);
			const without = yield* Effect.gen(function* () {
				const connection = yield* McpClient.connect({ server: "fixture", endpoint: stdio("server.mjs") });
				return JSON.parse(text(yield* connection.callTool({ name: "capabilities" }))) as Record<string, unknown>;
			}).pipe(Effect.scoped);
			summary.roots = { withRoots, withoutRoots: { capabilities: without } };
			expect(withRoots.roots).toEqual({
				roots: [
					{ uri: "file:///workspace/project", name: "project" },
					{ uri: "file:///srv/data%20dir", name: "data dir" },
				],
			});
			expect(without).not.toHaveProperty("roots");
		}),
	);

	it(
		"stdio: a missing command fails with ConnectError",
		Effect.gen(function* () {
			const error = yield* McpClient.connect({
				server: "missing",
				endpoint: { ...stdio("server.mjs"), command: "codework-mcp-missing-binary" },
				timeout: { startup: "5 seconds" },
			}).pipe(Effect.flip);
			summary.spawnFailure = failure(error);
			expect(error._tag).toBe("Mcp.ConnectError");
			expect(error.message).toBe("command not found: codework-mcp-missing-binary");
		}),
	);

	it(
		"onClose: silent on a deliberate scope close, immediate when the server already exited",
		Effect.gen(function* () {
			const deliberate = yield* Ref.make<ReadonlyArray<string>>([]);
			yield* Effect.gen(function* () {
				const connection = yield* McpClient.connect({ server: "fixture", endpoint: stdio("server.mjs") });
				connection.onClose((reason) => Ref.update(deliberate, (reasons) => [...reasons, reason]));
				yield* connection.tools();
			}).pipe(Effect.scoped);
			yield* Effect.sleep("300 millis");
			const afterScope = yield* Ref.get(deliberate);

			const connection = yield* McpClient.connect({ server: "fixture", endpoint: stdio("server.mjs") });
			const spawned = JSON.parse(text(yield* connection.callTool({ name: "spawn" }))) as { readonly server: number };
			yield* connection.callTool({ name: "exit" });
			expect(yield* gone([spawned.server])).toBe(true);
			// Requests fail once the transport is closed; then give the close a moment to settle.
			for (let attempt = 0; attempt < 50; attempt++) {
				if ((yield* connection.tools().pipe(Effect.exit))._tag === "Failure") break;
				yield* Effect.sleep("20 millis");
			}
			yield* Effect.sleep("300 millis");
			const late = yield* Deferred.make<string>();
			connection.onClose((reason) => Deferred.succeed(late, reason).pipe(Effect.asVoid));
			const reason = yield* Deferred.await(late).pipe(Effect.timeout("500 millis"));
			summary.onClose = { afterDeliberateClose: afterScope, afterServerExit: normalise(reason) };
			expect(afterScope).toEqual([]);
			expect(reason).toContain("connection closed");
		}),
	);

	it(
		"callTool: results are validated against the tool's output schema",
		Effect.gen(function* () {
			const connection = yield* McpClient.connect({ server: "fixture", endpoint: stdio("server.mjs") });
			// Listing caches the output schemas the SDK validates results against.
			const tools = yield* connection.tools();
			const missing = yield* connection.callTool({ name: "typed-missing" }).pipe(Effect.flip);
			const mismatch = yield* connection.callTool({ name: "typed-mismatch" }).pipe(Effect.flip);
			summary.outputSchema = {
				declared: tools.filter((tool) => tool.outputSchema !== undefined).map((tool) => tool.name),
				missing: failure(missing),
				mismatch: failure(mismatch),
			};
			expect(missing._tag).toBe("Mcp.RequestError");
			expect(mismatch._tag).toBe("Mcp.RequestError");
		}),
	);

	it(
		"http: a refused connection fails with ECONNREFUSED",
		Effect.gen(function* () {
			const port = yield* Effect.callback<number>((resume) => {
				const server = createServer();
				server.listen(0, "127.0.0.1", () => {
					const { port } = server.address() as AddressInfo;
					server.close(() => resume(Effect.succeed(port)));
				});
			});
			const error = yield* McpClient.connect({
				server: "refused",
				endpoint: http(new URL(`http://127.0.0.1:${port}/mcp`)),
				timeout: { startup: "5 seconds" },
			}).pipe(Effect.flip);
			summary.refused = { error: failure(error) };
			expect(error._tag).toBe("Mcp.ConnectError");
			expect(error.message).toContain("ECONNREFUSED");
		}),
	);

	it(
		"resources: paginated pages, missing templates handler, reads and list_changed",
		Effect.gen(function* () {
			const connection = yield* McpClient.connect({
				server: "resources",
				endpoint: stdio("server.mjs", { MCP_FIXTURE: "resources" }),
			});
			const changed = yield* Deferred.make<void>();
			connection.onResourcesChanged(Deferred.succeed(changed, undefined).pipe(Effect.asVoid));
			const templates = yield* connection.resourceTemplates();
			const first = yield* connection.resources();
			const second = yield* connection.resources(first.nextCursor);
			const read = yield* connection.readResource("fixture://one");
			yield* connection.readResource("fixture://changed");
			yield* Deferred.await(changed).pipe(Effect.timeout("2 seconds"));
			summary.resources = { templates, first, second, read, resourcesChanged: true };
			expect(templates).toEqual({ resourceTemplates: [] });
			expect(first).toEqual({ resources: [{ uri: "fixture://one", name: "one" }], nextCursor: "page-2" });
			expect(second).toEqual({ resources: [{ uri: "fixture://changed", name: "changed" }] });
			expect(read.contents).toEqual([
				{ uri: "fixture://one", mimeType: "text/plain", text: "contents of fixture://one" },
			]);
		}),
	);

	it(
		"tools: a server without the tools capability lists none and prints nothing",
		Effect.gen(function* () {
			const connection = yield* McpClient.connect({
				server: "resources",
				endpoint: stdio("server.mjs", { MCP_FIXTURE: "resources" }),
			});
			const write = vi.spyOn(process.stdout, "write");
			const debug = vi.spyOn(console, "debug");
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					write.mockRestore();
					debug.mockRestore();
				}),
			);
			const tools = yield* connection.tools();
			// Restoring clears the recorded calls, so count first.
			const printed = write.mock.calls.length + debug.mock.calls.length;
			summary.noToolsCapability = { tools, printed };
			expect(tools).toEqual([]);
			expect(printed).toBe(0);
		}),
	);

	it(
		"tools: list_changed from a server without tools.listChanged still reaches onToolsChanged",
		Effect.gen(function* () {
			const connection = yield* McpClient.connect({
				server: "plain",
				endpoint: stdio("server.mjs", { MCP_FIXTURE: "plain" }),
			});
			const changed = yield* Deferred.make<void>();
			connection.onToolsChanged(Deferred.succeed(changed, undefined).pipe(Effect.asVoid));
			yield* connection.callTool({ name: "frame" });
			yield* Deferred.await(changed).pipe(Effect.timeout("2 seconds"));
			summary.unadvertisedListChanged = { listChanged: connection.capabilities?.tools, toolsChanged: true };
			expect(connection.capabilities?.tools).toEqual({});
		}),
	);

	it(
		"stdio: a frame over 16 MiB fails the pending call and explains the close",
		Effect.gen(function* () {
			const connection = yield* McpClient.connect({ server: "fixture", endpoint: stdio("server.mjs") });
			const closed = yield* Deferred.make<string>();
			connection.onClose((reason) => Deferred.succeed(closed, reason).pipe(Effect.asVoid));
			const error = yield* connection.callTool({ name: "huge" }).pipe(Effect.flip);
			const reason = yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"));
			summary.frameLimit = { error: failure(error), reason: normalise(reason) };
			expect(error._tag).toBe("Mcp.RequestError");
			expect(error.message).toContain("frame exceeded 16 MiB");
			expect(error.message).not.toContain("process exited");
			expect(reason).toContain("frame exceeded 16 MiB");
		}),
		15_000,
	);

	it(
		"http: a 401 needs auth with an auth provider and is a ConnectError without one",
		Effect.gen(function* () {
			const server = raw({ unauthorized: true });
			const url = yield* listen(server.handler);
			const redirects: string[] = [];
			const authProvider: OAuthClientProvider = {
				redirectUrl: "http://127.0.0.1/callback",
				clientMetadata: { redirect_uris: ["http://127.0.0.1/callback"], client_name: "codework-test" },
				clientInformation: () => ({ client_id: "codework-test" }),
				tokens: () => undefined,
				saveTokens: () => {},
				redirectToAuthorization: (authorizationUrl) => {
					redirects.push(authorizationUrl.pathname);
				},
				saveCodeVerifier: () => {},
				codeVerifier: () => "verifier",
			};
			const withProvider = yield* McpClient.connect({ server: "oauth", endpoint: http(url), authProvider }).pipe(
				Effect.flip,
			);
			const without = yield* McpClient.connect({ server: "oauth", endpoint: http(url) }).pipe(Effect.flip);
			summary.unauthorized = { withProvider: failure(withProvider), redirects, without: failure(without) };
			expect(withProvider._tag).toBe("Mcp.NeedsAuthError");
			expect(without._tag).toBe("Mcp.ConnectError");
			expect(without.message).toContain("HTTP 401");
		}),
	);

	it(
		"http: a retried connect leaves no stale close reason; a deliberate close stays silent",
		Effect.gen(function* () {
			const server = raw({ failInitialize: 1 });
			const url = yield* listen(server.handler);
			const reasons = yield* Ref.make<ReadonlyArray<string>>([]);
			const connected = yield* Effect.gen(function* () {
				const connection = yield* McpClient.connect({ server: "raw", endpoint: http(url) });
				connection.onClose((reason) => Ref.update(reasons, (all) => [...all, reason]));
				yield* Effect.sleep("300 millis");
				const afterRegister = yield* Ref.get(reasons);
				const tools = yield* connection.tools();
				return { afterRegister, tools: tools.map((tool) => tool.name) };
			}).pipe(Effect.scoped);
			yield* Effect.sleep("300 millis");
			const afterScope = yield* Ref.get(reasons);
			const initializes = server.seen.filter((entry) => entry === "POST initialize").length;
			summary.retryCloseReason = { initializes, ...connected, afterScope };
			expect(initializes).toBe(2);
			expect(connected.afterRegister).toEqual([]);
			expect(afterScope).toEqual([]);
		}),
	);

	it(
		"stdio: a missing working directory fails with ConnectError",
		Effect.gen(function* () {
			const error = yield* McpClient.connect({
				server: "missing-cwd",
				endpoint: { ...stdio("server.mjs"), cwd: `${fixtures}missing-dir` },
				timeout: { startup: "5 seconds" },
			}).pipe(Effect.flip);
			summary.missingCwd = failure(error);
			expect(error._tag).toBe("Mcp.ConnectError");
			expect(error.message).toBe(`working directory not found: ${fixtures}missing-dir`);
		}),
	);

	it(
		"tools/list: strict pagination for null, empty and repeated cursors",
		Effect.gen(function* () {
			const list = (variant: string) =>
				Effect.gen(function* () {
					const connection = yield* McpClient.connect({
						server: "malformed",
						endpoint: stdio("malformed.mjs", { MCP_MALFORMED: variant }),
						timeout: { request: "5 seconds" },
					});
					const started = Date.now();
					const exit = yield* connection.tools().pipe(Effect.exit);
					return { exit, elapsed: Date.now() - started };
				}).pipe(Effect.scoped);
			const outcome = ({
				exit,
			}: {
				readonly exit: Exit.Exit<
					ReadonlyArray<{ readonly name: string }>,
					{ readonly _tag: string; readonly message: string }
				>;
			}) =>
				Exit.isSuccess(exit)
					? { tools: exit.value.map((tool) => tool.name) }
					: { error: Exit.findErrorOption(exit).pipe(Option.map(failure), Option.getOrUndefined) };
			const nullCursor = yield* list("null");
			const emptyCursor = yield* list("empty");
			const duplicate = yield* list("duplicate");
			summary.toolsPagination = {
				nullCursor: outcome(nullCursor),
				emptyCursor: outcome(emptyCursor),
				duplicate: outcome(duplicate),
			};
			expect(outcome(nullCursor).error).toEqual({
				tag: "Mcp.RequestError",
				message: "Invalid result for tools/list: nextCursor: Invalid input: expected string, received null",
			});
			// An empty cursor is followed as a real one, so the pages cycle until the SDK's cap.
			expect(outcome(emptyCursor).error?.message).toContain("exceeded listMaxPages");
			// The SDK stops quietly at a repeated cursor and returns the pages it has.
			expect(outcome(duplicate)).toEqual({ tools: ["t-start", "t-again"] });
			for (const run of [emptyCursor, duplicate]) expect(run.elapsed).toBeLessThan(5_000);
		}),
	);

	it(
		"resources: well-formed entries keep extra fields; entries without a name fail",
		Effect.gen(function* () {
			const valid = yield* Effect.gen(function* () {
				const connection = yield* McpClient.connect({
					server: "malformed",
					endpoint: stdio("malformed.mjs", { MCP_MALFORMED: "resources" }),
				});
				return { resources: yield* connection.resources(), templates: yield* connection.resourceTemplates() };
			}).pipe(Effect.scoped);
			const unnamed = yield* Effect.gen(function* () {
				const connection = yield* McpClient.connect({
					server: "malformed",
					endpoint: stdio("malformed.mjs", { MCP_MALFORMED: "unnamed" }),
				});
				return {
					resources: yield* connection.resources().pipe(Effect.flip),
					templates: yield* connection.resourceTemplates().pipe(Effect.flip),
				};
			}).pipe(Effect.scoped);
			summary.strictResources = {
				valid,
				unnamed: { resources: failure(unnamed.resources), templates: failure(unnamed.templates) },
			};
			expect(valid.resources.resources).toEqual([
				{
					uri: "file:///a.txt",
					name: "a",
					description: "A file",
					mimeType: "text/plain",
					_meta: { origin: "fixture" },
				},
			]);
			expect(valid.templates.resourceTemplates).toEqual([
				{ uriTemplate: "file:///{path}", name: "files", description: "Any file" },
			]);
			expect(failure(unnamed.resources)).toEqual({
				tag: "Mcp.RequestError",
				message:
					"Invalid result for resources/list: resources.0.name: Invalid input: expected string, received undefined",
			});
			expect(failure(unnamed.templates)).toEqual({
				tag: "Mcp.RequestError",
				message:
					"Invalid result for resources/templates/list: resourceTemplates.0.name: Invalid input: expected string, received undefined",
			});
		}),
	);

	it(
		"tools/list: an invalid entry fails with RequestError",
		Effect.gen(function* () {
			const connection = yield* McpClient.connect({
				server: "malformed",
				endpoint: stdio("malformed.mjs", { MCP_MALFORMED: "invalid" }),
			});
			const error = yield* connection.tools().pipe(Effect.flip);
			summary.invalidEntry = failure(error);
			expect(failure(error)).toEqual({
				tag: "Mcp.RequestError",
				message:
					"Invalid result for tools/list: tools.1.inputSchema: Invalid input: expected object, received undefined",
			});
		}),
	);

	it(
		"onLog: receives the server's notifications/message params",
		Effect.gen(function* () {
			const connection = yield* McpClient.connect({ server: "fixture", endpoint: stdio("server.mjs") });
			const entries = yield* Ref.make<ReadonlyArray<LoggingMessageNotificationParams>>([]);
			connection.onLog((entry) => Ref.update(entries, (all) => [...all, entry]));
			yield* connection.callTool({ name: "log" });
			for (let attempt = 0; attempt < 50 && (yield* Ref.get(entries)).length < 2; attempt++)
				yield* Effect.sleep("20 millis");
			const received = yield* Ref.get(entries);
			summary.onLog = received;
			expect(received).toEqual(logEntries);
		}),
	);

	it(
		"McpLog: writes formatted lines with indented continuations",
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const log = yield* McpLog.make(join(dir, "logs", "mcp.log"));
			for (const entry of logEntries) yield* log.write("fixture", entry);
			const lines = readFileSync(log.path, "utf8").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z/gm, "<iso>");
			summary.logFile = lines.split("\n");
			expect(lines).toBe(
				[
					"<iso> [fixture] info first line",
					"    second line",
					'<iso> [fixture] warning db: {"query":"select 1","ms":3}',
					"",
				].join("\n"),
			);
		}),
	);

	it(
		"McpLog: rotates a file over 5 MB to <path>.1",
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const path = join(dir, "mcp.log");
			const old = `${"x".repeat(5 * 1024 * 1024 + 16)}\n`;
			writeFileSync(path, old);
			const log = yield* McpLog.make(path);
			yield* log.write("fixture", logEntries[1]!);
			const rotated = readFileSync(`${path}.1`, "utf8") === old;
			const current = readFileSync(path, "utf8").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z/gm, "<iso>");
			summary.logRotation = { rotated, current };
			expect(rotated).toBe(true);
			expect(current).toBe('<iso> [fixture] warning db: {"query":"select 1","ms":3}\n');
		}),
	);

	it(
		"http: an unanswered initialized notification times the connect out and ends the session",
		Effect.gen(function* () {
			const server = raw({
				script: (request) => (request === "POST notifications/initialized" ? "hang" : undefined),
			});
			const url = yield* listen(server.handler);
			const started = Date.now();
			const error = yield* McpClient.connect({
				server: "raw",
				endpoint: http(url),
				timeout: { startup: "500 millis" },
			}).pipe(Effect.flip);
			const elapsed = Date.now() - started;
			summary.initializedTimeout = { error: failure(error), deleted: server.seen.includes("DELETE") };
			expect(error._tag).toBe("Mcp.ConnectError");
			expect(error.message).toContain("mcp connect timed out after");
			expect(elapsed).toBeLessThan(2_000);
		}),
	);

	it(
		"http: a failed connect attempt deletes the session it was given",
		Effect.gen(function* () {
			const unsupported = raw({ protocolVersion: "1999-01-01" });
			const failing = raw({
				script: (request) =>
					request === "POST notifications/initialized" ? { status: 500, body: "notification failed" } : undefined,
			});
			const errors = [];
			for (const server of [unsupported, failing]) {
				const url = yield* listen(server.handler);
				const error = yield* McpClient.connect({
					server: "raw",
					endpoint: http(url),
					timeout: { startup: "2 seconds" },
				}).pipe(Effect.flip);
				errors.push({ error: failure(error), seen: [...server.seen].filter((entry) => entry !== "GET") });
			}
			summary.failedConnectSession = { unsupported: errors[0], failedNotification: errors[1] };
			expect(errors.map(({ error, seen }) => ({ tag: error.tag, deleted: seen.includes("DELETE") }))).toEqual([
				{ tag: "Mcp.ConnectError", deleted: true },
				{ tag: "Mcp.ConnectError", deleted: true },
			]);
		}),
	);

	it(
		"http: list requests retry a transient 503; tool calls never retry",
		Effect.gen(function* () {
			let listFailures = 1;
			const server = raw({
				script: (request) => {
					if (request === "POST tools/list" && listFailures-- > 0) return { status: 503, body: "overloaded" };
					// The call has run its side effect before the server fails the response.
					if (request === "POST tools/call") return { status: 503, body: "overloaded" };
					return undefined;
				},
			});
			const url = yield* listen(server.handler);
			const connection = yield* McpClient.connect({ server: "raw", endpoint: http(url) });
			const tools = yield* connection.tools();
			const call = yield* connection.callTool({ name: "echo" }).pipe(Effect.flip);
			const count = (key: string) => server.seen.filter((entry) => entry === key).length;
			summary.httpRetries = {
				tools: tools.map((tool) => tool.name),
				listRequests: count("POST tools/list"),
				call: failure(call),
				callRequests: count("POST tools/call"),
			};
			expect(count("POST tools/list")).toBe(2);
			expect(call._tag).toBe("Mcp.RequestError");
			expect(count("POST tools/call")).toBe(1);
		}),
	);

	it(
		"http: closing the scope deletes the session once, and a hanging DELETE is bounded",
		Effect.gen(function* () {
			const normal = raw();
			const normalUrl = yield* listen(normal.handler);
			yield* McpClient.connect({ server: "raw", endpoint: http(normalUrl) }).pipe(Effect.scoped);
			const deletes = normal.seen.filter((entry) => entry === "DELETE").length;

			const hanging = raw({ script: (request) => (request === "DELETE" ? "hang" : undefined) });
			const hangingUrl = yield* listen(hanging.handler);
			let closedIn = 0;
			yield* Effect.gen(function* () {
				yield* McpClient.connect({ server: "raw", endpoint: http(hangingUrl) });
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						closedIn = Date.now();
					}),
				);
			}).pipe(Effect.scoped);
			// Finalizers run in reverse: the one above runs first, so this times the client's close.
			const elapsed = Date.now() - closedIn;
			summary.httpClose = { deletes, hangingDeleteBounded: elapsed < 1_500 };
			expect(deletes).toBe(1);
			expect(hanging.seen).toContain("DELETE");
			expect(elapsed).toBeLessThan(1_500);
		}),
	);

	it(
		"http: a 400 'Server not initialized' expires the session; any other 400 is a request error",
		Effect.gen(function* () {
			const reply = (body: string) => {
				let armed = false;
				const server = raw({
					script: (request) => (armed && request === "POST tools/list" ? { status: 400, body } : undefined),
				});
				return { server, arm: () => (armed = true) };
			};
			const run = (body: string) =>
				Effect.gen(function* () {
					const { server, arm } = reply(body);
					const url = yield* listen(server.handler);
					const connection = yield* McpClient.connect({ server: "raw", endpoint: http(url) });
					arm();
					return failure(yield* connection.tools().pipe(Effect.flip));
				}).pipe(Effect.scoped);
			const notInitialized = yield* run(
				JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32000, message: "Bad Request: Server not initialized" },
					id: null,
				}),
			);
			const other = yield* run(
				JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32000, message: "Bad Request: something else" },
					id: null,
				}),
			);
			summary.http400 = { notInitialized, other };
			expect(notInitialized.tag).toBe("Mcp.SessionExpiredError");
			expect(other.tag).toBe("Mcp.RequestError");
		}),
	);

	it(
		"writes the scenario artifact",
		Effect.gen(function* () {
			// A filtered run must not snapshot a partial summary.
			expect(Object.keys(summary).sort()).toEqual([...scenarios].sort());
			yield* Effect.promise(() => expect(summary).toMatchFileSnapshot("./__artifacts__/mcp.client.json"));
		}),
	);
});
