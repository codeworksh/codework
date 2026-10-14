import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import { Deferred, Effect, Exit, Fiber, Option, Ref } from "effect";
import { describe, expect, vi } from "vite-plus/test";
import { McpClient } from "../src/mcp/client.ts";
import { McpContent } from "../src/mcp/content.ts";
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
const http = (url: URL): McpClient.Http => ({ _tag: "Http", url, headers: {} });

/** Each scenario's observable outcome, written to the artifact by the last test. */
const summary: Record<string, unknown> = {};

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

describe("mcp client", () => {
	it(
		"stdio: connects, lists tools and converts every content kind",
		Effect.gen(function* () {
			const connection = yield* McpClient.connect({ server: "fixture", endpoint: stdio("server.mjs") });
			const tools = yield* connection.tools();
			const echo = yield* connection.callTool({ name: "echo", args: { text: "hi" } });
			const mixed = yield* connection.callTool({ name: "mixed" });
			const structured = yield* connection.callTool({ name: "structured" });
			summary.stdioHappy = {
				serverInfo: connection.serverInfo,
				instructions: connection.instructions,
				tools: tools.map((tool) => tool.name),
				echo: McpContent.fromResult(echo),
				mixed: McpContent.fromResult(mixed),
				structured: McpContent.fromResult(structured),
			};
			expect(connection.instructions).toBe("Use the echo tool.");
			expect(McpContent.fromResult(echo)).toEqual([{ type: "text", text: "hi" }]);
			expect(McpContent.fromResult(mixed)).toEqual([
				{ type: "text", text: "hello" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
				{ type: "text", text: "embedded notes" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
				{ type: "text", text: "[binary resource file:///data.bin (unknown type) omitted]" },
				{ type: "text", text: "[audio audio/wav omitted]" },
				{ type: "text", text: "readme: file:///README.md" },
			]);
			expect(McpContent.fromResult(structured)).toEqual([
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
				echo: McpContent.fromResult(echo),
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
			const pids = yield* Effect.gen(function* () {
				const connection = yield* McpClient.connect({ server: "fixture", endpoint: stdio("server.mjs") });
				const spawned = JSON.parse(text(yield* connection.callTool({ name: "spawn" }))) as {
					readonly server: number;
					readonly grandchild: number;
				};
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
			const started = Date.now();
			const pids = yield* Effect.gen(function* () {
				const connection = yield* McpClient.connect({ server: "stubborn", endpoint: stdio("stubborn.mjs") });
				const spawned = JSON.parse(connection.instructions ?? "{}") as {
					readonly server: number;
					readonly grandchild: number;
				};
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
			const fiber = yield* connection.callTool({ name: "hang" }).pipe(Effect.forkChild);
			yield* Effect.sleep("200 millis");
			yield* Fiber.interrupt(fiber);
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
		"http: a refused connection fails with ECONNREFUSED after retrying",
		Effect.gen(function* () {
			const port = yield* Effect.callback<number>((resume) => {
				const server = createServer();
				server.listen(0, "127.0.0.1", () => {
					const { port } = server.address() as AddressInfo;
					server.close(() => resume(Effect.succeed(port)));
				});
			});
			const started = Date.now();
			const error = yield* McpClient.connect({
				server: "refused",
				endpoint: http(new URL(`http://127.0.0.1:${port}/mcp`)),
				timeout: { startup: "5 seconds" },
			}).pipe(Effect.flip);
			const elapsed = Date.now() - started;
			summary.refused = { error: failure(error), retried: elapsed >= 1_200 };
			expect(error._tag).toBe("Mcp.ConnectError");
			expect(error.message).toContain("ECONNREFUSED");
			expect(elapsed).toBeGreaterThanOrEqual(1_200);
			expect(elapsed).toBeLessThan(5_000);
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
			const tools = yield* connection.tools().pipe(
				Effect.ensuring(
					Effect.sync(() => {
						write.mockRestore();
						debug.mockRestore();
					}),
				),
			);
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
			expect(outcome(nullCursor).error?.tag).toBe("Mcp.RequestError");
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
			expect(unnamed.resources._tag).toBe("Mcp.RequestError");
			expect(unnamed.templates._tag).toBe("Mcp.RequestError");
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
			expect(error._tag).toBe("Mcp.RequestError");
		}),
	);

	it(
		"writes the scenario artifact",
		Effect.promise(() => expect(summary).toMatchFileSnapshot("./__artifacts__/mcp.client.json")),
	);
});
