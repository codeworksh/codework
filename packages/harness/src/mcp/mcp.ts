/**
 * The MCP servers each session runs, kept connected across its exchanges.
 *
 * Every exchange hands over the session's servers as its `mcp` plugins left them ({@link
 * Interface.reconcile}); servers whose connection settings changed restart, removed ones close, new
 * ones connect in the background. The tools an exchange registers are the ones the servers offered
 * at that moment, frozen with the rest of the exchange; the connection behind a tool is looked up
 * when it is called:
 *
 * - A connection that drops fails the calls running on it, and the next call reconnects.
 * - A Streamable HTTP session the server forgot is replaced, and calls that hit it run once more on
 *   the new one. The old connection closes when its last call finishes, never under one.
 * - A tool call is never retried after the server may have run it.
 * - A changed tool list takes effect at the next exchange; a call to a withdrawn tool says so.
 *
 * Each connection lives in its own scope under the service's, so closing it, or shutting the
 * service down, stops the server process and ends the HTTP session.
 */

import type { ServerConfig } from "@codeworksh/plugin/plugin/mcp";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import {
	Cause,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	Layer,
	Schema,
	Scope,
	Semaphore,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { NeedsAuthError } from "./error.ts";
import type { ID as SessionId } from "../session/schema.ts";
import type { RegisteredTool } from "../tool/tool.ts";
import { McpClient } from "./client.ts";
import { McpLog } from "./log.ts";
import { McpTool } from "./tool.ts";
import { McpValue } from "./value.ts";
import { hostPath } from "../host.ts";
import { expandTilde } from "../util/home.ts";

/** An exchange waits this long for the servers it started whose tools are declared to the model. */
const STARTUP_WAIT = Duration.seconds(10);
const DEFAULT_TIMEOUT_SECONDS = 60;

export type State = "connecting" | "connected" | "disconnected" | "failed" | "needs-auth" | "disabled";

export interface Status {
	readonly server: string;
	readonly state: State;
	readonly error?: string;
	/** Tools the server offered when last listed. */
	readonly tools: number;
}

export interface Input {
	readonly sessionId: SessionId;
	readonly servers: ReadonlyArray<readonly [name: string, config: ServerConfig]>;
	/**
	 * Where stdio servers start (a server's own relative `cwd` resolves against it), and the root
	 * sent to servers: the session's directory when its sandbox is the host's own filesystem. Absent
	 * otherwise, since that directory does not exist here; servers then start in the session's host
	 * directory and are sent no roots.
	 */
	readonly directory?: string | undefined;
	readonly hostDir?: string | undefined;
	/** Configuration problems from `mcp.json`, reported once per session. */
	readonly errors?: ReadonlyArray<string>;
}

export interface Interface {
	/** Settle a session's servers for its next exchange, and return the tools that exchange declares. */
	readonly reconcile: (input: Input) => Effect.Effect<ReadonlyArray<RegisteredTool>>;
	readonly status: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<Status>>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/mcp/mcp/Service") {}

interface Live {
	readonly connection: McpClient.Connection;
	readonly scope: Scope.Closeable;
	inflight: number;
	retired: boolean;
}

interface Server {
	readonly name: string;
	config: ServerConfig;
	/** Everything a connection is made from; a change restarts the server. */
	readonly key: string;
	readonly cwd: string;
	readonly roots: ReadonlyArray<string> | undefined;
	state: State;
	error: string | undefined;
	tools: ReadonlyArray<Tool>;
	live: Live | undefined;
	/** The connect attempt in progress. Callers share it; closing the server interrupts it. */
	attempt: Fiber.Fiber<Live, string> | undefined;
	/** Settles when the first background attempt finishes. */
	ready: Deferred.Deferred<void> | undefined;
	closed: boolean;
	readonly lock: Semaphore.Semaphore;
}

interface Session {
	readonly servers: Map<string, Server>;
	readonly names: ReturnType<typeof McpTool.names>;
	readonly lock: Semaphore.Semaphore;
	readonly reported: Set<string>;
}

/** The parts of a config that decide the connection; exposure and description do not. */
const connectionKey = (config: ServerConfig, cwd: string, roots: ReadonlyArray<string> | undefined) => {
	const { exposure: _exposure, toolExposure: _tools, description: _description, enabled, ...rest } = config;
	return JSON.stringify({ rest, enabled: enabled !== false, cwd, roots });
};

const hasDirectTools = (config: ServerConfig) =>
	(config.exposure ?? "direct") === "direct" ||
	Object.values(config.toolExposure ?? {}).some((exposure) => exposure === "direct");

export const layer = (options: { readonly hostCwd: string; readonly home: string }) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const root = yield* Effect.scope;
			const fork = yield* FiberSet.makeRuntime<never, void, never>();
			const forkAttempt = yield* FiberSet.makeRuntime<never, Live, string>();
			const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
			const log = yield* McpLog.make(hostPath.join(options.home, "mcp.log"));
			const sessions = new Map<SessionId, Session>();
			// Shared remote endpoints should not see a burst of concurrent startups.
			const endpoints = new Map<string, Semaphore.Semaphore>();
			const endpointLock = (url: string) => {
				let lock = endpoints.get(url);
				if (lock === undefined) endpoints.set(url, (lock = Semaphore.makeUnsafe(1)));
				return lock;
			};

			const release = (live: Live) =>
				live.retired && live.inflight === 0 ? Scope.close(live.scope, Exit.void) : Effect.void;

			/** Stop handing out this connection; it closes once no call runs on it. */
			const retire = (server: Server, live: Live) =>
				Effect.suspend(() => {
					live.retired = true;
					if (server.live === live) server.live = undefined;
					return release(live);
				});

			const endpoint = Effect.fnUntraced(function* (server: Server) {
				const config = server.config;
				const what = `MCP server "${server.name}"`;
				if ("url" in config)
					return {
						_tag: "Http",
						url: new URL(config.url),
						headers: yield* McpValue.resolveAll(config.headers ?? {}, `${what} header`),
					} satisfies McpClient.Http;
				return {
					_tag: "Stdio",
					// One executable and its arguments, not a command line: only a leading `~/` is expanded.
					command: expandTilde(config.command, hostPath),
					args: (config.args ?? []).map((arg) => expandTilde(arg, hostPath)),
					env: yield* McpValue.resolveAll(config.env ?? {}, `${what} env`),
					cwd: hostPath.resolve(server.cwd, expandTilde(config.cwd ?? ".", hostPath)),
				} satisfies McpClient.Stdio;
			});

			const watch = (server: Server, live: Live) => {
				// Callbacks run in the connection's own scope, and retiring closes that scope; run them
				// in the service's instead, or closing would wait on the callback doing the closing.
				const current = (effect: Effect.Effect<void>) =>
					Effect.sync(() => {
						fork(
							Effect.suspend(() => (server.live === live ? effect : Effect.void)).pipe(
								server.lock.withPermits(1),
							),
						);
					});
				live.connection.onClose((reason) =>
					current(
						Effect.gen(function* () {
							server.state = "disconnected";
							server.error = reason;
							yield* retire(server, live);
						}),
					),
				);
				// Calls replace an expired session themselves; this covers a background request seeing it first.
				live.connection.onSessionExpired(current(retire(server, live)));
				live.connection.onToolsChanged(
					current(
						live.connection.tools().pipe(
							Effect.tap((tools) =>
								Effect.sync(() => {
									server.tools = tools;
								}),
							),
							Effect.catch((error) =>
								Effect.sync(() => {
									server.error = `failed to refresh tools: ${error.message}`;
								}),
							),
						),
					),
				);
				live.connection.onLog((entry) => log.write(server.name, entry));
			};

			/** One connect attempt, run apart from any caller so that closing the server can interrupt it. */
			const attempt = (server: Server): Effect.Effect<Live, string> =>
				Effect.gen(function* () {
					const scope = yield* Scope.fork(root, "sequential");
					const config = server.config;
					const connect = Effect.gen(function* () {
						const target = yield* endpoint(server);
						const connection = yield* McpClient.connect({
							server: server.name,
							endpoint: target,
							...(server.roots === undefined ? {} : { roots: server.roots }),
							timeout: { request: Duration.seconds(config.timeout ?? DEFAULT_TIMEOUT_SECONDS) },
						}).pipe(Scope.provide(scope));
						const tools = yield* connection.tools();
						return { connection, tools };
					});
					const exit = yield* ("url" in config ? endpointLock(config.url).withPermit(connect) : connect).pipe(
						Effect.onInterrupt(() => Scope.close(scope, Exit.void)),
						Effect.exit,
					);
					if (Exit.isFailure(exit)) {
						yield* Scope.close(scope, Exit.void);
						const error = Cause.squash(exit.cause);
						const message =
							typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
						server.state = Schema.is(NeedsAuthError)(error) ? "needs-auth" : "failed";
						server.error = message;
						yield* Effect.logWarning("mcp connect failed", { server: server.name, error: message });
						return yield* Effect.fail(message);
					}
					const live: Live = { connection: exit.value.connection, scope, inflight: 0, retired: false };
					server.live = live;
					server.tools = exit.value.tools;
					server.state = "connected";
					server.error = undefined;
					watch(server, live);
					yield* Effect.logInfo("mcp connected", { server: server.name, tools: server.tools.length });
					return live;
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							server.attempt = undefined;
						}),
					),
					Effect.provide(context),
				);

			/** The server's current connection, connecting first when it has none. */
			const open = (server: Server): Effect.Effect<Live, string> =>
				Effect.gen(function* () {
					const next = yield* Effect.gen(function* () {
						if (server.closed) return yield* Effect.fail(`MCP server "${server.name}" is shut down`);
						const current = server.live;
						// A drop is known here before its `onClose` handler has run.
						const reason = current?.connection.dropped();
						if (current !== undefined && reason === undefined) return current;
						if (current !== undefined) {
							server.state = "disconnected";
							server.error = reason;
							yield* retire(server, current);
						}
						if (server.attempt === undefined) {
							server.state = "connecting";
							server.attempt = forkAttempt(attempt(server));
						}
						return server.attempt;
					}).pipe(server.lock.withPermits(1));
					if (!Fiber.isFiber(next)) return next;
					// An interrupted caller leaves the attempt running for whoever needs the server next.
					const exit = yield* Fiber.await(next);
					if (Exit.isSuccess(exit)) return exit.value;
					return yield* Cause.hasInterruptsOnly(exit.cause)
						? Effect.fail(`MCP server "${server.name}" is shut down`)
						: Effect.failCause(exit.cause);
				});

			/** Stop the server: interrupt a connect in progress, and retire the connection it has. */
			const close = (server: Server) =>
				Effect.gen(function* () {
					server.closed = true;
					const pending = server.attempt;
					if (pending !== undefined) yield* Fiber.interrupt(pending);
					yield* Effect.suspend(() =>
						server.live === undefined ? Effect.void : retire(server, server.live),
					).pipe(server.lock.withPermits(1));
				});

			/** One call of one of the server's tools, on whichever connection is current when it runs. */
			const call =
				(session: Session, name: string, tool: string) =>
				(input: McpTool.Call): Effect.Effect<CallToolResult, string> =>
					Effect.gen(function* () {
						for (let attempt = 1; ; attempt++) {
							const server = session.servers.get(name);
							if (server === undefined || server.closed || server.config.enabled === false)
								return yield* Effect.fail(`MCP server "${name}" is disabled.`);
							if (
								McpTool.exposure(server.config, tool) === "hidden" ||
								(server.live !== undefined && !server.tools.some((offered) => offered.name === tool))
							)
								return yield* Effect.fail(`MCP tool "${name}/${tool}" is no longer available.`);
							const live = yield* open(server).pipe(
								Effect.mapError((error) => `MCP server "${name}" is not connected: ${error}`),
							);
							live.inflight += 1;
							const exit = yield* live.connection
								.callTool({ name: tool, args: input.args, onProgress: input.onProgress })
								.pipe(
									Effect.exit,
									Effect.ensuring(
										Effect.suspend(() => {
											live.inflight -= 1;
											return release(live);
										}),
									),
								);
							if (Exit.isSuccess(exit)) return exit.value;
							const error = Cause.findErrorOption(exit.cause);
							if (error._tag === "None") return yield* Effect.failCause(exit.cause as Cause.Cause<never>);
							const failure = error.value;
							// The server no longer knows the session, so it did not run the call.
							if (failure._tag === "Mcp.SessionExpiredError" && attempt === 1) {
								yield* retire(server, live).pipe(server.lock.withPermits(1));
								continue;
							}
							if (failure._tag === "Mcp.NeedsAuthError") {
								yield* Effect.gen(function* () {
									server.state = "needs-auth";
									server.error = failure.message;
									yield* retire(server, live);
								}).pipe(server.lock.withPermits(1));
								return yield* Effect.fail(`MCP server "${name}" needs sign-in: ${failure.message}`);
							}
							return yield* Effect.fail(`MCP tool "${name}/${tool}" failed: ${failure.message}`);
						}
					});

			/** Connect in the background; `ready` settles when the attempt does. */
			const start = (server: Server) => {
				if (server.config.enabled === false) {
					server.state = "disabled";
					return;
				}
				const ready = Deferred.makeUnsafe<void>();
				server.ready = ready;
				fork(open(server).pipe(Effect.ignore, Effect.ensuring(Deferred.succeed(ready, undefined))));
			};

			const sessionOf = (sessionId: SessionId) => {
				let session = sessions.get(sessionId);
				if (session === undefined) {
					session = {
						servers: new Map(),
						names: McpTool.names(),
						lock: Semaphore.makeUnsafe(1),
						reported: new Set(),
					};
					sessions.set(sessionId, session);
				}
				return session;
			};

			const reconcile = Effect.fn("Mcp.reconcile")(function* (input: Input) {
				const session = sessionOf(input.sessionId);
				for (const error of input.errors ?? []) {
					if (session.reported.has(error)) continue;
					session.reported.add(error);
					yield* Effect.logWarning(`mcp config: ${error}`);
				}
				const cwd = input.directory ?? input.hostDir ?? options.hostCwd;
				const roots = input.directory === undefined ? undefined : [input.directory];
				const wanted = new Map(input.servers);
				const started: Server[] = [];
				yield* Effect.gen(function* () {
					for (const [name, server] of session.servers) {
						const config = wanted.get(name);
						// Exposure and description apply to the next exchange without reconnecting.
						if (config !== undefined && connectionKey(config, cwd, roots) === server.key) {
							server.config = config;
							continue;
						}
						session.servers.delete(name);
						yield* close(server);
					}
					for (const [name, config] of wanted) {
						if (session.servers.has(name)) continue;
						const server: Server = {
							name,
							config,
							key: connectionKey(config, cwd, roots),
							cwd,
							roots,
							state: "connecting",
							error: undefined,
							tools: [],
							live: undefined,
							attempt: undefined,
							ready: undefined,
							closed: false,
							lock: Semaphore.makeUnsafe(1),
						};
						session.servers.set(name, server);
						start(server);
						started.push(server);
					}
				}).pipe(session.lock.withPermits(1));

				// Wait for servers this exchange started (all of them at first, then new or restarted ones) so
				// their tools are declared in its first request, but never indefinitely: one hanging server
				// must not hold up the prompt.
				const pending = started.filter(
					(server) => server.config.enabled !== false && hasDirectTools(server.config),
				);
				if (pending.length > 0) {
					const finished = yield* Effect.forEach(pending, (server) =>
						server.ready === undefined ? Effect.void : Deferred.await(server.ready),
					).pipe(Effect.timeoutOption(STARTUP_WAIT));
					if (finished._tag === "None")
						yield* Effect.logInfo("mcp servers are still connecting; their tools appear once connected");
				}

				const tools: RegisteredTool[] = [];
				for (const server of session.servers.values()) {
					if (server.config.enabled === false || server.tools.length === 0) continue;
					const names = session.names(
						server.name,
						server.tools.map((tool) => tool.name),
					);
					for (const tool of server.tools) {
						if (McpTool.exposure(server.config, tool.name) !== "direct") continue;
						tools.push(
							McpTool.make({
								server: server.name,
								tool,
								name: names.get(tool.name)!,
								call: call(session, server.name, tool.name),
							}),
						);
					}
				}
				return tools;
			});

			return Service.of({
				reconcile,
				status: (sessionId) =>
					Effect.sync(() =>
						[...(sessions.get(sessionId)?.servers.values() ?? [])].map((server) => ({
							server: server.name,
							state: server.state,
							...(server.error === undefined ? {} : { error: server.error }),
							tools: server.tools.length,
						})),
					),
			});
		}),
	);

export * as Mcp from "./mcp.ts";
