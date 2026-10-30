/**
 * The MCP servers each thread runs, kept connected across its turns.
 *
 * Every turn hands over the thread's servers as its `mcp` plugins left them ({@link
 * Interface.reconcile}); servers whose connection settings changed restart, removed ones close, new
 * ones connect in the background. The tools a turn registers are the ones the servers offered at
 * that moment, each with its exposure, frozen with the rest of the turn; the connection behind a
 * tool is looked up when it is called:
 *
 * - A connection that drops fails the calls running on it, and the next call reconnects.
 * - Reconcile never restarts a failed server; only a config change or {@link Interface.connect}
 *   does. A server whose tools were declared still reconnects on its next call.
 * - A Streamable HTTP session the server forgot is replaced, and calls that hit it run once more on
 *   the new one. The old connection closes when its last call finishes, never under one.
 * - A tool call is never retried after the server may have run it.
 * - A changed tool list takes effect at the next turn; a call to a withdrawn tool says so.
 *
 * Every state change is published to the owning thread as an ephemeral `mcp.server.status` event.
 *
 * Each connection lives in its own scope under the service's, so closing it, or shutting the
 * service down, stops the server process and ends the HTTP session.
 */

import type { Exposure, ServerConfig } from "@codeworksh/plugin/plugin/mcp";
import type { Tool } from "@modelcontextprotocol/client";
import {
	Cause,
	Context,
	DateTime,
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
import { NeedsAuthError, UnknownServerError } from "./error.ts";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import type { ID as SessionId } from "../session/schema.ts";
import type { ID as ThreadId } from "../thread/schema.ts";
import type { RegisteredTool } from "../tool/tool.ts";
import { McpClient } from "./client.ts";
import { namespace } from "./config.ts";
import { McpLog } from "./log.ts";
import { McpOutput } from "./output.ts";
import { McpResources } from "./resources.ts";
import { McpTool } from "./tool.ts";
import { McpValue } from "./value.ts";
import { hostPath } from "../host.ts";
import { expandTilde } from "../util/home.ts";

/** A turn waits this long for the servers it started whose tools it declares or has loaded. */
const STARTUP_WAIT = Duration.seconds(10);
const DEFAULT_TIMEOUT_SECONDS = 60;

export type State = EventList.McpServerState["state"];

export interface Status {
	readonly server: string;
	readonly state: State;
	readonly error?: string;
	/** Tools the server offered when last listed, each with its exposure; kept while it is not connected. */
	readonly tools: ReadonlyArray<{ readonly name: string; readonly exposure: Exposure }>;
}

export interface Input {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly servers: ReadonlyArray<readonly [name: string, config: ServerConfig]>;
	/**
	 * Where stdio servers start (a server's own relative `cwd` resolves against it), and the root
	 * sent to servers: the session's directory when its sandbox is the host's own filesystem. Absent
	 * otherwise, since that directory does not exist here; servers then start in the session's host
	 * directory and are sent no roots.
	 */
	readonly directory?: string | undefined;
	readonly hostDir?: string | undefined;
	/** Configuration problems from `mcp.json`, reported once per thread. */
	readonly errors?: ReadonlyArray<string>;
	/** Deferred tools the thread has loaded (its `modelTools.add`); their servers are waited for like direct ones. */
	readonly loaded?: ReadonlyArray<string> | undefined;
}

export interface Interface {
	/** Settle a thread's servers for its next turn, and return every tool they offer, with its exposure. */
	readonly reconcile: (input: Input) => Effect.Effect<ReadonlyArray<RegisteredTool>>;
	readonly status: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Status>>;
	/** Close the server's connection or attempt and connect it afresh, returning its state after that attempt. */
	readonly connect: (threadId: ThreadId, server: string) => Effect.Effect<Status, UnknownServerError>;
	/** Close the server and keep it disconnected until {@link connect} or a config change. */
	readonly disconnect: (threadId: ThreadId, server: string) => Effect.Effect<Status, UnknownServerError>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/mcp/mcp/Service") {}

interface Live {
	readonly connection: McpClient.Connection;
	readonly scope: Scope.Closeable;
	inflight: number;
	retired: boolean;
	/** Bumped by every `tools/list_changed`, so only the latest listing is kept. */
	refreshes: number;
}

interface Server {
	readonly name: string;
	readonly thread: Thread;
	config: ServerConfig;
	/** Everything a connection is made from; a change restarts the server. */
	readonly key: string;
	readonly cwd: string;
	readonly roots: ReadonlyArray<string> | undefined;
	state: State;
	error: string | undefined;
	tools: ReadonlyArray<Tool>;
	/** Whether the server offered resources when it last connected. */
	resources: boolean;
	live: Live | undefined;
	/** The connect attempt in progress. Callers share it; closing the server interrupts it. */
	attempt: Fiber.Fiber<Live, string> | undefined;
	/** Settles when the first background attempt finishes. */
	ready: Deferred.Deferred<void> | undefined;
	closed: boolean;
	/** Disconnected on request: nothing connects it until `connect` or a config change. */
	stopped: boolean;
	/** The last status published, so a no-op change publishes nothing. */
	published: string | undefined;
	readonly lock: Semaphore.Semaphore;
	/** Runs `connect` and `disconnect` one at a time. */
	readonly control: Semaphore.Semaphore;
}

interface Thread {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
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

/** Whether a loaded tool name could belong to the server; its tools are not known before it connects. */
const loadsFrom = (server: string, loaded: ReadonlyArray<string>) =>
	loaded.some((name) => name.startsWith(`${namespace(server)}__`));

const statusOf = (server: Server): Status => ({
	server: server.name,
	state: server.state,
	...(server.error === undefined ? {} : { error: server.error }),
	tools: server.tools.map((tool) => ({ name: tool.name, exposure: McpTool.exposure(server.config, tool.name) })),
});

const eventStatus = (server: Server): EventList.McpServerState => {
	const { name, state } = server;
	switch (state) {
		case "connected":
			return { server: name, state, tools: server.tools.map((tool) => tool.name) };
		case "failed":
		case "authenticate":
			return { server: name, state, error: server.error ?? state };
		case "disconnected":
			return { server: name, state, ...(server.error === undefined ? {} : { error: server.error }) };
		case "connecting":
		case "disabled":
			return { server: name, state };
	}
};

export const layer = (options: { readonly hostCwd: string; readonly home: string }) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const root = yield* Effect.scope;
			const events = yield* Event.Service;
			// Connections close in parallel on shutdown, so one slow server's stop grace does not hold up
			// the rest. Made before the fibers below, so connect attempts are interrupted before it closes.
			const servers = yield* Scope.fork(root, "parallel");
			const fork = yield* FiberSet.makeRuntime<never, void, never>();
			const forkAttempt = yield* FiberSet.makeRuntime<never, Live, string>();
			const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
			const log = yield* McpLog.make(hostPath.join(options.home, "mcp.log"));
			const threads = new Map<ThreadId, Thread>();
			// Shared remote endpoints should not see a burst of concurrent startups.
			const endpoints = new Map<string, Semaphore.Semaphore>();
			const endpointLock = (url: string) => {
				let lock = endpoints.get(url);
				if (lock === undefined) endpoints.set(url, (lock = Semaphore.makeUnsafe(1)));
				return lock;
			};

			/** Publish the server's status to its thread, unless it is the one published last. */
			const publish = (server: Server) =>
				Effect.suspend(() => {
					const status = eventStatus(server);
					const key = [
						status.state,
						"error" in status ? (status.error ?? "") : "",
						...("tools" in status ? status.tools : []),
					].join("\0");
					if (key === server.published) return Effect.void;
					server.published = key;
					const { sessionId, threadId } = server.thread;
					return DateTime.now.pipe(
						Effect.flatMap((timestamp) =>
							events.publish(EventList.McpServerStatus, { timestamp, sessionId, threadId, status }),
						),
						Effect.asVoid,
					);
				});

			/** The one place a server's state changes. */
			const setState = (server: Server, state: State, error?: string) =>
				Effect.suspend(() => {
					server.state = state;
					server.error = error;
					return publish(server);
				});

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
						headers: yield* McpValue.resolveAll(config.headers ?? {}, "header", `${what} header`),
					} satisfies McpClient.Http;
				return {
					_tag: "Stdio",
					// One executable and its arguments, not a command line: only a leading `~/` is expanded.
					command: expandTilde(config.command, hostPath),
					args: (config.args ?? []).map((arg) => expandTilde(arg, hostPath)),
					env: yield* McpValue.resolveAll(config.env ?? {}, "env", `${what} env`),
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
							yield* setState(server, "disconnected", reason);
							yield* retire(server, live);
						}),
					),
				);
				// Calls replace an expired session themselves; this covers a background request seeing it first.
				live.connection.onSessionExpired(current(retire(server, live)));
				// Listed without the server's lock, which calls and closing need: the listing can take a while.
				// Listings can finish out of order; only the latest one counts.
				live.connection.onToolsChanged(
					Effect.sync(() => {
						const refresh = ++live.refreshes;
						const latest = () => server.live === live && live.refreshes === refresh;
						fork(
							live.connection.tools().pipe(
								Effect.matchEffect({
									onSuccess: (tools) =>
										Effect.suspend(() => {
											if (!latest()) return Effect.void;
											server.tools = tools;
											return publish(server);
										}),
									onFailure: (error) =>
										Effect.sync(() => {
											if (latest()) server.error = `failed to refresh tools: ${error.message}`;
										}),
								}),
							),
						);
					}),
				);
			};

			/** One connect attempt, run apart from any caller so that closing the server can interrupt it. */
			const attempt = (server: Server): Effect.Effect<Live, string> =>
				Effect.gen(function* () {
					const scope = yield* Scope.fork(servers, "sequential");
					const config = server.config;
					const connect = Effect.gen(function* () {
						const target = yield* endpoint(server);
						const connection = yield* McpClient.connect({
							server: server.name,
							endpoint: target,
							...(server.roots === undefined ? {} : { roots: server.roots }),
							timeout: { request: Duration.seconds(config.timeout ?? DEFAULT_TIMEOUT_SECONDS) },
							// Written on the service's fibers: a failed handshake closes the connection's, and
							// its last messages usually say why.
							onLog: (entry) => Effect.sync(() => fork(log.write(server.name, entry))),
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
						if (server.closed || server.stopped) return yield* Effect.fail(message);
						yield* setState(server, Schema.is(NeedsAuthError)(error) ? "authenticate" : "failed", message);
						yield* Effect.logWarning("mcp connect failed", { server: server.name, error: message });
						return yield* Effect.fail(message);
					}
					// Closed or disconnected while connecting: the connection must not outlive that.
					if (server.closed || server.stopped) {
						yield* Scope.close(scope, Exit.void);
						return yield* Effect.fail(
							`MCP server "${server.name}" is ${server.closed ? "shut down" : "disconnected"}`,
						);
					}
					const live: Live = {
						connection: exit.value.connection,
						scope,
						inflight: 0,
						retired: false,
						refreshes: 0,
					};
					server.live = live;
					server.tools = exit.value.tools;
					server.resources = exit.value.connection.capabilities?.resources !== undefined;
					yield* setState(server, "connected");
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
						if (server.stopped) return yield* Effect.fail(`MCP server "${server.name}" is disconnected`);
						const current = server.live;
						// A drop is known here before its `onClose` handler has run.
						const reason = current?.connection.dropped();
						if (current !== undefined && reason === undefined) return current;
						if (current !== undefined) {
							yield* setState(server, "disconnected", reason);
							yield* retire(server, current);
						}
						if (server.attempt === undefined) {
							yield* setState(server, "connecting");
							// Started after the assignment: an attempt that fails at once would otherwise clear
							// `attempt` before it is set, and the finished fiber would stand in for every retry.
							server.attempt = forkAttempt(Effect.andThen(Effect.yieldNow, attempt(server)));
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

			/** Interrupt a connect in progress, and retire the connection the server has. */
			const stop = (server: Server) =>
				Effect.gen(function* () {
					const pending = server.attempt;
					if (pending !== undefined) yield* Fiber.interrupt(pending);
					if (server.live !== undefined) yield* retire(server, server.live);
				}).pipe(server.lock.withPermits(1));

			/** Stop the server for good: it was removed, or its connection settings changed. */
			const close = (server: Server) =>
				Effect.suspend(() => {
					server.closed = true;
					return stop(server);
				});

			/**
			 * One request on whichever connection of the server is current when it runs. `what` names
			 * it in a failure. A request the server never saw, because it had forgotten the session,
			 * runs once more on a new one; nothing else is retried here.
			 */
			const request =
				/** `what` prefixes a failure, naming what failed; without it the server's message is the failure. */
				(thread: Thread, name: string, what: string | undefined) =>
					<A>(
						run: (connection: McpClient.Connection) => Effect.Effect<A, McpClient.Failed>,
						/** Why the server, as it stands, no longer offers what is asked; checked before every attempt. */
						unavailable: (server: Server) => string | undefined = () => undefined,
					): Effect.Effect<A, string> =>
						Effect.gen(function* () {
							for (let attempt = 1; ; attempt++) {
								const server = thread.servers.get(name);
								if (server === undefined || server.closed || server.config.enabled === false)
									return yield* Effect.fail(`MCP server "${name}" is disabled.`);
								const reason = unavailable(server);
								if (reason !== undefined) return yield* Effect.fail(reason);
								const live = yield* open(server).pipe(
									Effect.mapError((error) => `MCP server "${name}" is not connected: ${error}`),
								);
								live.inflight += 1;
								const exit = yield* run(live.connection).pipe(
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
								if (failure._tag === "Mcp.SessionExpiredError" && attempt === 1) {
									yield* retire(server, live).pipe(server.lock.withPermits(1));
									continue;
								}
								if (failure._tag === "Mcp.NeedsAuthError") {
									yield* Effect.gen(function* () {
										yield* setState(server, "authenticate", failure.message);
										yield* retire(server, live);
									}).pipe(server.lock.withPermits(1));
									return yield* Effect.fail(`MCP server "${name}" needs sign-in: ${failure.message}`);
								}
								return yield* Effect.fail(
									what === undefined ? failure.message : `${what} failed: ${failure.message}`,
								);
							}
						});

			/** One call of one of the server's tools. A tool call is never retried after the server may have run it. */
			const call = (thread: Thread, name: string, tool: string) => (run: McpTool.Run) =>
				request(
					thread,
					name,
					`MCP tool "${name}/${tool}"`,
				)(
					(connection) => connection.callTool({ name: tool, args: run.args, onProgress: run.onProgress }),
					(server) =>
						McpTool.exposure(server.config, tool) === "hidden" ||
						(server.live !== undefined && !server.tools.some((offered) => offered.name === tool))
							? `MCP tool "${name}/${tool}" is no longer available.`
							: undefined,
				);

			/** Servers the resource tools reach: enabled, connectable, offering resources, and not hidden. */
			const withResources = (server: Server) =>
				server.config.enabled !== false &&
				!server.stopped &&
				server.resources &&
				(server.config.exposure ?? "direct") !== "hidden";

			const resourceServer = (thread: Thread, name: string): McpResources.Server => {
				// Listings name the server beside each failure already.
				const reach = request(thread, name, undefined);
				return {
					name,
					resources: (cursor) => reach((connection) => connection.resources(cursor)),
					templates: (cursor) => reach((connection) => connection.resourceTemplates(cursor)),
					allResources: () => reach((connection) => connection.allResources()),
					allTemplates: () => reach((connection) => connection.allResourceTemplates()),
					read: (uri) => reach((connection) => connection.readResource(uri)),
				};
			};

			/** Connect in the background; `ready` settles when the attempt does. */
			const start = (server: Server) =>
				Effect.suspend(() => {
					if (server.config.enabled === false) return setState(server, "disabled");
					const ready = Deferred.makeUnsafe<void>();
					server.ready = ready;
					fork(open(server).pipe(Effect.ignore, Effect.ensuring(Deferred.succeed(ready, undefined))));
					return Effect.void;
				});

			const threadOf = (input: Input) => {
				let thread = threads.get(input.threadId);
				if (thread === undefined) {
					thread = {
						sessionId: input.sessionId,
						threadId: input.threadId,
						servers: new Map(),
						names: McpTool.names(),
						lock: Semaphore.makeUnsafe(1),
						reported: new Set(),
					};
					threads.set(input.threadId, thread);
				}
				return thread;
			};

			const serverOf = (threadId: ThreadId, name: string) => {
				const server = threads.get(threadId)?.servers.get(name);
				return server === undefined
					? Effect.fail(new UnknownServerError({ server: name }))
					: Effect.succeed(server);
			};

			const reconcile = Effect.fn("Mcp.reconcile")(function* (input: Input) {
				const thread = threadOf(input);
				for (const error of input.errors ?? []) {
					if (thread.reported.has(error)) continue;
					thread.reported.add(error);
					yield* Effect.logWarning(`mcp config: ${error}`);
				}
				const cwd = input.directory ?? input.hostDir ?? options.hostCwd;
				const roots = input.directory === undefined ? undefined : [input.directory];
				const wanted = new Map(input.servers);
				const started: Server[] = [];
				yield* Effect.gen(function* () {
					for (const [name, server] of thread.servers) {
						const config = wanted.get(name);
						// Exposure and description apply to the next turn without reconnecting.
						if (config !== undefined && connectionKey(config, cwd, roots) === server.key) {
							server.config = config;
							continue;
						}
						thread.servers.delete(name);
						// Stopping can take seconds; the prompt does not wait for it.
						fork(close(server));
					}
					for (const [name, config] of wanted) {
						if (thread.servers.has(name)) continue;
						const server: Server = {
							name,
							thread,
							config,
							key: connectionKey(config, cwd, roots),
							cwd,
							roots,
							state: "connecting",
							error: undefined,
							tools: [],
							resources: false,
							live: undefined,
							attempt: undefined,
							ready: undefined,
							closed: false,
							stopped: false,
							published: undefined,
							lock: Semaphore.makeUnsafe(1),
							control: Semaphore.makeUnsafe(1),
						};
						thread.servers.set(name, server);
						yield* start(server);
						started.push(server);
					}
					// A thread with no servers and nothing reported has nothing worth keeping.
					if (thread.servers.size === 0 && thread.reported.size === 0 && threads.get(thread.threadId) === thread)
						threads.delete(thread.threadId);
				}).pipe(thread.lock.withPermits(1));

				// Wait for servers this turn started (all of them at first, then new or restarted ones) so
				// their tools are offered in its first request, but never indefinitely: one hanging server
				// must not hold up the prompt.
				const loaded = input.loaded ?? [];
				const pending = started.filter(
					(server) =>
						server.config.enabled !== false && (hasDirectTools(server.config) || loadsFrom(server.name, loaded)),
				);
				if (pending.length > 0) {
					const finished = yield* Effect.forEach(pending, (server) =>
						server.ready === undefined ? Effect.void : Deferred.await(server.ready),
					).pipe(Effect.timeoutOption(STARTUP_WAIT));
					if (finished._tag === "None")
						yield* Effect.logInfo("mcp servers are still connecting; their tools appear once connected");
				}

				// Every tool is registered with its exposure; the registry decides which ones are offered.
				const tools: RegisteredTool[] = [];
				const output = { save: McpOutput.save };
				const content = (server: Server) => ({ ...output, readable: withResources(server) });
				for (const server of thread.servers.values()) {
					if (server.config.enabled === false || server.stopped || server.tools.length === 0) continue;
					const names = thread.names(
						server.name,
						server.tools.map((tool) => tool.name),
					);
					for (const tool of server.tools) {
						tools.push(
							McpTool.make({
								server: server.name,
								tool,
								name: names.get(tool.name)!,
								exposure: McpTool.exposure(server.config, tool.name),
								call: call(thread, server.name, tool.name),
								content: content(server),
							}),
						);
					}
				}
				if ([...thread.servers.values()].some(withResources))
					tools.push(
						...McpResources.make({
							servers: () =>
								[...thread.servers.values()]
									.filter(withResources)
									.map((server) => resourceServer(thread, server.name)),
							// A server still connecting may offer resources once it has.
							ready: () =>
								Effect.forEach(
									[...thread.servers.values()],
									(server) =>
										server.config.enabled === false || server.ready === undefined
											? Effect.void
											: Deferred.await(server.ready),
									{ discard: true },
								),
							content: output,
						}),
					);
				return tools;
			});

			/**
			 * Run `operation` on the thread's server, one operation per server at a time. A turn that
			 * replaced or removed the server meanwhile makes it unknown, so a stale status is never returned.
			 */
			const control = (threadId: ThreadId, name: string, operation: (server: Server) => Effect.Effect<void>) =>
				Effect.gen(function* () {
					const server = yield* serverOf(threadId, name);
					return yield* Effect.gen(function* () {
						if (server.config.enabled !== false) yield* operation(server);
						if (threads.get(threadId)?.servers.get(name) !== server)
							return yield* new UnknownServerError({ server: name });
						return statusOf(server);
					}).pipe(server.control.withPermits(1));
				});

			const connect = Effect.fn("Mcp.connect")((threadId: ThreadId, name: string) =>
				control(threadId, name, (server) =>
					Effect.gen(function* () {
						server.stopped = false;
						yield* stop(server);
						// An explicit restart is reported even when an interrupted attempt left it `connecting`.
						server.published = undefined;
						yield* open(server).pipe(Effect.ignore);
					}),
				),
			);

			const disconnect = Effect.fn("Mcp.disconnect")((threadId: ThreadId, name: string) =>
				control(threadId, name, (server) =>
					Effect.gen(function* () {
						server.stopped = true;
						yield* stop(server);
						yield* setState(server, "disconnected");
					}),
				),
			);

			return Service.of({
				reconcile,
				status: (threadId) => Effect.sync(() => [...(threads.get(threadId)?.servers.values() ?? [])].map(statusOf)),
				connect,
				disconnect,
			});
		}),
	);

export * as Mcp from "./mcp.ts";
