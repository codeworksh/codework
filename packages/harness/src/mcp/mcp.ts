/**
 * The MCP servers threads run, kept connected across their turns.
 *
 * A server's `scope` decides who shares a running instance of it: the threads of one session at the
 * same place, every session in a space, or the whole app. An instance is keyed by that scope and by
 * everything its connection is made from, so threads that resolve different settings never share
 * one.
 *
 * Every turn hands over the thread's servers as its `mcp` plugins left them ({@link
 * Interface.reconcile}); a thread moves to a new instance when a server's connection settings
 * change, stops using one it no longer names, and new instances connect in the background. Exposure
 * stays the thread's own: two threads can share an instance and show the model different tools.
 *
 * A running drain holds a {@link Interface.lease} on its thread's instances. An instance no thread
 * uses any more closes at once; one no drain holds closes after an idle timeout. The tools a turn
 * registers are the ones the servers offered at that moment, each with its exposure, frozen with the
 * rest of the turn; the connection behind a tool is looked up when it is called:
 *
 * - A connection that drops fails the calls running on it, and the next call reconnects.
 * - Reconcile never restarts a failed server; only a config change or {@link Interface.connect}
 *   does. A server whose tools were declared still reconnects on its next call, and one waiting for
 *   sign-in reconnects on a turn once its stored credential changed.
 * - A Streamable HTTP session the server forgot is replaced, and calls that hit it run once more on
 *   the new one. The old connection closes when its last call finishes, never under one.
 * - A tool call is never retried after the server may have run it.
 * - A changed tool list takes effect at the next turn; a call to a withdrawn tool says so.
 *
 * Every state change of an instance is published, as an ephemeral `mcp.server.status` event, to
 * each thread using it.
 *
 * Each connection lives in its own scope under the service's, so closing it, or shutting the
 * service down, stops the server process and ends the HTTP session.
 */

import type { Message } from "@codeworksh/aikit";
import type { Exposure, ServerConfig } from "@codeworksh/plugin/plugin/mcp";
import type { AuthProvider, Tool } from "@modelcontextprotocol/client";
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
import {
	ConnectError,
	type McpError,
	NeedsAuthError,
	ToolCallError,
	UnavailableError,
	UnknownServerError,
} from "./error.ts";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import { ID as SessionId } from "../session/schema.ts";
import { ID as ThreadId } from "../thread/schema.ts";
import { type RegisteredTool, toAikitTool } from "../tool/tool.ts";
import { McpClient } from "./client.ts";
import { namespace } from "./config.ts";
import { McpLog } from "./log.ts";
import { McpOAuth } from "./oauth.ts";
import { McpOutput } from "./output.ts";
import { McpResources } from "./resources.ts";
import { McpTool } from "./tool.ts";
import { McpValue } from "./value.ts";
import { hostPath } from "../host.ts";
import { ModelCatalog } from "../model/catalog.ts";
import { expandTilde } from "../util/home.ts";

/**
 * A turn waits this long for the servers it started whose tools it declares or has loaded, and a
 * search of deferred tools for the servers still connecting.
 */
const STARTUP_WAIT = Duration.seconds(10);
/** An instance no running drain holds closes after this long. */
const IDLE_TIMEOUT = Duration.minutes(10);
const DEFAULT_TIMEOUT_SECONDS = 60;

export type State = typeof EventList.McpState.Type;

export interface Status {
	readonly server: string;
	readonly state: State;
	readonly error?: string;
	/** Tools the server offered when last listed, each with its exposure in the thread; kept while it is not connected. */
	readonly tools: ReadonlyArray<{ readonly name: string; readonly exposure: Exposure }>;
	/**
	 * Whether the server offered resources when it last connected; kept while it is not connected.
	 * The resource tools reach it only while it is not disconnected on request, and not hidden.
	 */
	readonly resources: boolean;
	/** The tools it listed last that were left out because the SDK rejects them; absent when none were. */
	readonly skipped?: EventList.McpSkipped;
}

export interface Input {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
	readonly servers: ReadonlyArray<readonly [name: string, config: ServerConfig]>;
	/**
	 * Where a `session` server starts (its own relative `cwd` resolves against it), and the root sent
	 * to it: the thread's directory when its sandbox is the host's own filesystem. Absent otherwise,
	 * since that directory does not exist here; servers then start in the session's host directory
	 * and are sent no roots.
	 */
	readonly directory?: string | undefined;
	/** The thread's space; `root`, its folder, only when the space is on the host's own filesystem. */
	readonly space: { readonly id: string; readonly root?: string | undefined };
	readonly hostDir?: string | undefined;
	/** Configuration problems from `mcp.json`, reported once per thread. */
	readonly errors?: ReadonlyArray<string>;
	/** Deferred tools the thread has loaded (its `modelTools.add`); their servers are waited for like direct ones. */
	readonly loaded?: ReadonlyArray<string> | undefined;
}

export interface Reconciled {
	/** Every tool the thread's servers offer, with its exposure. */
	readonly tools: ReadonlyArray<RegisteredTool>;
	/**
	 * Whether an enabled server of the thread is configured with `deferred` exposure, whatever its
	 * state: taken from config, so it holds before the server connects and after it fails.
	 */
	readonly defers: boolean;
	/**
	 * The thread's deferred tools as they stand when it runs, under the names they are registered by.
	 * Waits first, within {@link STARTUP_WAIT}, for those servers' connect attempts in progress.
	 */
	readonly deferred: Effect.Effect<ReadonlyArray<Message.Tool>>;
}

export interface Interface {
	/** Settle a thread's servers for its next turn. */
	readonly reconcile: (input: Input) => Effect.Effect<Reconciled>;
	/** Keep the thread's instances open for as long as the calling scope, a drain, runs. */
	readonly lease: (thread: {
		readonly sessionId: SessionId;
		readonly threadId: ThreadId;
	}) => Effect.Effect<void, never, Scope.Scope>;
	readonly status: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Status>>;
	/** Wait until each of the thread's servers has finished its first connect attempt. */
	readonly settle: (threadId: ThreadId) => Effect.Effect<void>;
	/**
	 * Close the instance's connection or attempt and connect it afresh, for every thread sharing it,
	 * returning its state after that attempt.
	 */
	readonly connect: (threadId: ThreadId, server: string) => Effect.Effect<Status, UnknownServerError>;
	/** Close the instance and keep it disconnected, for every thread sharing it, until {@link connect} or a config change. */
	readonly disconnect: (threadId: ThreadId, server: string) => Effect.Effect<Status, UnknownServerError>;
	/** Forget the threads of a deleted session, and close the instances no other thread uses. */
	readonly remove: (sessionId: SessionId) => Effect.Effect<void>;
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

/** One running instance of a server, shared by the threads whose servers resolve to its key. */
interface Server {
	readonly name: string;
	/** The config it was started with. Exposure is read from each thread's own config instead. */
	readonly config: ServerConfig;
	/** The scope and everything a connection is made from. */
	readonly key: string;
	readonly cwd: string;
	readonly roots: ReadonlyArray<string> | undefined;
	state: State;
	error: string | undefined;
	tools: ReadonlyArray<Tool>;
	/** The tools its last listing left out, when it left any out. */
	skipped: EventList.McpSkipped | undefined;
	/** Whether the server offered resources when it last connected. */
	resources: boolean;
	/** The credential it was refused with, when it needs sign-in: a new one is worth a retry. */
	refused: string | undefined;
	live: Live | undefined;
	/** The connect attempt in progress. Callers share it; closing the server interrupts it. */
	attempt: Fiber.Fiber<Live, ConnectError> | undefined;
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
	/** Threads whose servers resolve to this instance. */
	readonly users: Set<ThreadId>;
	/** Drains holding it open. */
	leases: number;
	/** Bumped whenever the lease count changes, so an idle timer can tell it went stale. */
	generation: number;
}

/** One of a thread's servers: its own config, and the instance it resolves to unless disabled. */
interface Entry {
	readonly config: ServerConfig;
	readonly server: Server | undefined;
}

interface Thread {
	readonly id: ThreadId;
	readonly sessionId: SessionId;
	readonly servers: Map<string, Entry>;
	readonly names: ReturnType<typeof McpTool.names>;
	readonly lock: Semaphore.Semaphore;
	readonly reported: Set<string>;
	/** Whether the thread was told its `codemode` tools cannot be reached. */
	warnedUnreachable: boolean;
	/** Running drains of this thread. */
	leases: number;
}

/** JSON with object keys sorted, so the same settings written in another order give the same key. */
const canonical = (value: unknown): string =>
	Array.isArray(value)
		? `[${value.map(canonical).join(",")}]`
		: value !== null && typeof value === "object"
			? `{${Object.keys(value)
					.sort()
					.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
					.join(",")}}`
			: JSON.stringify(value);

/**
 * The scope, the server's name and the parts of its config that decide the connection; exposure and
 * description do not. The name is part of it so that two entries are always two instances, and a
 * thread's servers map one to one onto the instances it uses.
 */
const instanceKey = (
	scope: string,
	name: string,
	config: ServerConfig,
	cwd: string,
	roots: ReadonlyArray<string> | undefined,
) => {
	const { exposure: _exposure, toolExposure: _tools, description: _description, enabled: _enabled, ...rest } = config;
	return canonical({ scope, name, rest, cwd, roots });
};

const exposureOf = (config: ServerConfig) => config.exposure ?? "direct";

/** An `Authorization` header is the user's own credential; OAuth stays out of its way. */
const usesOAuth = (config: ServerConfig) =>
	"url" in config &&
	config.auth === undefined &&
	!Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");

/** What the model reads about a server that needs sign-in: how the user signs in. */
const signInHint = (name: string, config: ServerConfig) =>
	"url" in config && config.auth !== undefined
		? `MCP server "${name}" refused the credential of provider "${config.auth.provider}". Sign in to it with "codework auth login", or set its API key.`
		: `MCP server "${name}" requires sign-in. Run "codework mcp login ${name}".`;

const hasTools = (config: ServerConfig, exposure: Exposure) =>
	exposureOf(config) === exposure || Object.values(config.toolExposure ?? {}).some((one) => one === exposure);

/** Whether a loaded tool name could belong to the server; its tools are not known before it connects. */
const loadsFrom = (server: string, loaded: ReadonlyArray<string>) =>
	loaded.some((name) => name.startsWith(`${namespace(server)}__`));

/** A thread's server as that thread sees it: the instance's state, with the thread's own exposure. */
const statusOf = (name: string, entry: Entry): Status => {
	const server = entry.server;
	if (server === undefined) return { server: name, state: "disabled", tools: [], resources: false };
	return {
		server: name,
		state: server.closed ? "disconnected" : server.state,
		...(server.error === undefined ? {} : { error: server.error }),
		tools: server.tools.map((tool) => ({ name: tool.name, exposure: McpTool.exposure(entry.config, tool.name) })),
		resources: server.resources,
		...(server.skipped === undefined ? {} : { skipped: server.skipped }),
	};
};

/** Settles when the server's first background connect attempt does. */
const firstAttempt = (server: Server | undefined) =>
	server?.ready === undefined ? Effect.void : Deferred.await(server.ready);

const eventStatus = (server: Server): EventList.McpServerState => {
	const { name, state } = server;
	switch (state) {
		case "connected":
			return {
				server: name,
				state,
				tools: server.tools.map((tool) => tool.name),
				...(server.skipped === undefined ? {} : { skipped: server.skipped }),
			};
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

export const layer = (options: {
	readonly hostCwd: string;
	readonly home: string;
	/** Where provider logins are read for `auth.provider`; see {@link ModelCatalog.Credentials}. */
	readonly authFile?: string | undefined;
	/** How long an instance no drain holds stays open. Default: 10 minutes. */
	readonly idleTimeout?: Duration.Input | undefined;
}) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const root = yield* Effect.scope;
			const events = yield* Event.Service;
			// Connections close in parallel on shutdown, so one slow server's stop grace does not hold up
			// the rest. Made before the fibers below, so connect attempts are interrupted before it closes.
			const servers = yield* Scope.fork(root, "parallel");
			const fork = yield* FiberSet.makeRuntime<never, void, never>();
			const forkAttempt = yield* FiberSet.makeRuntime<never, Live, ConnectError>();
			const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
			const log = yield* McpLog.make(hostPath.join(options.home, "mcp.log"));
			const oauth = McpOAuth.store(options.home);
			const threads = new Map<ThreadId, Thread>();
			const instances = new Map<string, Server>();
			const idleTimeout = options.idleTimeout ?? IDLE_TIMEOUT;
			// Shared remote endpoints should not see a burst of concurrent startups.
			const endpoints = new Map<string, Semaphore.Semaphore>();
			const endpointLock = (url: string) => {
				let lock = endpoints.get(url);
				if (lock === undefined) endpoints.set(url, (lock = Semaphore.makeUnsafe(1)));
				return lock;
			};

			/** Publish a status to each of these threads. */
			const publishTo = (users: Iterable<ThreadId>, status: EventList.McpServerState) =>
				Effect.flatMap(DateTime.now, (timestamp) =>
					Effect.forEach(
						[...users].flatMap((threadId) => {
							const thread = threads.get(threadId);
							return thread === undefined ? [] : [thread];
						}),
						(thread) =>
							events.publish(EventList.McpServerStatus, {
								timestamp,
								sessionId: thread.sessionId,
								threadId: thread.id,
								status,
							}),
						{ discard: true },
					),
				);

			/** Tell a thread that joined a running instance its status, unless the instance published since. */
			const publishJoined = (thread: Thread, server: Server, seen: string | undefined) =>
				Effect.flatMap(DateTime.now, (timestamp) =>
					// Checked with nothing in between it and the publish, so no newer status can slip ahead.
					seen === undefined || server.published !== seen
						? Effect.void
						: Effect.asVoid(
								events.publish(EventList.McpServerStatus, {
									timestamp,
									sessionId: thread.sessionId,
									threadId: thread.id,
									status: eventStatus(server),
								}),
							),
				);

			/** Publish the instance's status to every thread using it, unless it is the one published last. */
			const publish = (server: Server) =>
				Effect.suspend(() => {
					const status = eventStatus(server);
					const skipped = "skipped" in status ? status.skipped : undefined;
					const key = [
						status.state,
						"error" in status ? (status.error ?? "") : "",
						...("tools" in status ? status.tools : []),
						...(skipped === undefined ? [] : ["\u0001skipped", ...skipped.names, String(skipped.unnamed)]),
					].join("\0");
					if (key === server.published) return Effect.void;
					server.published = key;
					return publishTo(server.users, status);
				});

			/** The one place an instance's state changes. */
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

			const oauthServer = (server: Server) =>
				"url" in server.config
					? { name: server.name, url: server.config.url, oauth: server.config.oauth }
					: undefined;

			/** The credential a request to the server carries, if the harness supplies one. */
			const credential = Effect.fnUntraced(function* (server: Server) {
				const config = server.config;
				if ("url" in config && config.auth !== undefined)
					return yield* ModelCatalog.providerToken(config.auth.provider, options.authFile).pipe(
						Effect.orElseSucceed(() => undefined),
					);
				const target = oauthServer(server);
				if (target === undefined || !usesOAuth(config)) return undefined;
				return yield* McpOAuth.accessToken(oauth, target);
			});

			const authProvider = Effect.fnUntraced(function* (server: Server) {
				const config = server.config;
				if (!("url" in config)) return undefined;
				if (config.auth !== undefined) {
					// Read on every request, so the provider's refreshes apply; MCP keeps no copy.
					return {
						token: () => Effect.runPromiseWith(context)(credential(server)),
					} satisfies AuthProvider;
				}
				if (!usesOAuth(config)) return undefined;
				return yield* McpOAuth.connection({ store: oauth, server: oauthServer(server)! });
			});

			/** The server needs sign-in: remember what it was refused with, and any scope it asked for. */
			const needsSignIn = (server: Server, error: NeedsAuthError) =>
				Effect.gen(function* () {
					server.refused = yield* credential(server);
					yield* setState(server, "authenticate", signInHint(server.name, server.config));
					const target = oauthServer(server);
					if (target !== undefined && error.scope !== undefined)
						yield* McpOAuth.remember(oauth, target, {
							scope: error.scope,
							resourceMetadataUrl: error.resourceMetadataUrl,
							error: "insufficient_scope",
						}).pipe(Effect.ignore);
				});

			/** Take in a listing: the tools the SDK accepts, and the ones it left out, each logged with why. */
			const listed = (server: Server, connection: McpClient.Connection, tools: ReadonlyArray<Tool>) =>
				Effect.suspend(() => {
					const skipped = connection.skipped();
					const names = skipped.flatMap((tool) => (tool.name === undefined ? [] : [tool.name]));
					server.tools = tools;
					server.skipped = skipped.length === 0 ? undefined : { names, unnamed: skipped.length - names.length };
					return Effect.forEach(
						skipped,
						(tool) =>
							log.write(server.name, {
								level: "warning",
								logger: "codework",
								data: `skipped ${tool.name === undefined ? "a tool without a name" : `tool "${tool.name}"`}: ${tool.reason}`,
							}),
						{ discard: true },
					);
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
										Effect.suspend(() =>
											latest()
												? Effect.andThen(listed(server, live.connection, tools), publish(server))
												: Effect.void,
										),
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
			const attempt = (server: Server): Effect.Effect<Live, ConnectError> =>
				Effect.gen(function* () {
					const scope = yield* Scope.fork(servers, "sequential");
					const config = server.config;
					const connect = Effect.gen(function* () {
						const target = yield* endpoint(server);
						const auth = yield* authProvider(server);
						const connection = yield* McpClient.connect({
							server: server.name,
							endpoint: target,
							...(auth === undefined ? {} : { authProvider: auth }),
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
						if (server.closed || server.stopped) return yield* new ConnectError({ server: server.name, message });
						yield* Effect.logWarning("mcp connect failed", { server: server.name, error: message });
						if (Schema.is(NeedsAuthError)(error)) {
							yield* needsSignIn(server, error);
							return yield* new ConnectError({ server: server.name, message: server.error! });
						}
						yield* setState(server, "failed", message);
						return yield* new ConnectError({ server: server.name, message });
					}
					// Closed or disconnected while connecting: the connection must not outlive that.
					if (server.closed || server.stopped) {
						yield* Scope.close(scope, Exit.void);
						return yield* new ConnectError({ server: server.name, message: halted(server) });
					}
					const live: Live = {
						connection: exit.value.connection,
						scope,
						inflight: 0,
						retired: false,
						refreshes: 0,
					};
					server.live = live;
					yield* listed(server, live.connection, exit.value.tools);
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

			/** Why the server has no connection to offer: closed, disconnected, or between attempts. */
			const halted = (server: Server) =>
				`MCP server "${server.name}" is ${server.closed ? "shut down" : server.stopped ? "disconnected" : "reconnecting"}`;

			/** The server's current connection, connecting first when it has none. */
			const open = (server: Server): Effect.Effect<Live, ConnectError | UnavailableError> =>
				Effect.gen(function* () {
					const unavailable = () => new UnavailableError({ server: server.name, message: halted(server) });
					const next = yield* Effect.gen(function* () {
						if (server.closed || server.stopped) return yield* unavailable();
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
					// Interrupted by `connect`, `disconnect` or closing; the server's state now says which.
					return yield* Cause.hasInterruptsOnly(exit.cause)
						? Effect.fail(unavailable())
						: Effect.failCause(exit.cause);
				});

			/** Interrupt a connect in progress, and retire the connection the instance has. */
			const stop = (server: Server) =>
				Effect.gen(function* () {
					const pending = server.attempt;
					if (pending !== undefined) yield* Fiber.interrupt(pending);
					if (server.live !== undefined) yield* retire(server, server.live);
				}).pipe(server.lock.withPermits(1));

			/** Stop the instance for good: nobody uses it any more, or it idled out. */
			const close = (server: Server) =>
				Effect.suspend(() => {
					if (instances.get(server.key) === server) instances.delete(server.key);
					server.closed = true;
					// Threads still using an instance that idled out learn it is gone, as `status` already says.
					return Effect.andThen(setState(server, "disconnected"), stop(server));
				});

			/**
			 * One request on whichever connection of the server is current when it runs. `what` names
			 * it in a failure. A request the server never saw, because it had forgotten the session,
			 * runs once more on a new one; nothing else is retried here.
			 */
			const request =
				(thread: Thread, name: string, failed: (message: string) => ToolCallError) =>
				<A>(
					run: (connection: McpClient.Connection) => Effect.Effect<A, McpClient.Failed>,
					/** Why the server, as it stands, no longer offers what is asked; checked before every attempt. */
					unavailable: (entry: Entry, server: Server) => string | undefined = () => undefined,
				): Effect.Effect<A, McpError.Failure> =>
					Effect.gen(function* () {
						const refuse = (message: string) => new UnavailableError({ server: name, message });
						for (let attempt = 1; ; attempt++) {
							const entry = thread.servers.get(name);
							const server = entry?.server;
							if (entry === undefined || server === undefined)
								return yield* refuse(`MCP server "${name}" is disabled.`);
							if (server.closed) return yield* refuse(`MCP server "${name}" is shut down.`);
							const reason = unavailable(entry, server);
							if (reason !== undefined) return yield* refuse(reason);
							const live = yield* open(server).pipe(
								// A server that needs sign-in says how to sign in, which is all the model can pass on.
								Effect.mapError((error) =>
									refuse(
										server.state === "authenticate"
											? error.message
											: `MCP server "${name}" is not connected: ${error.message}`,
									),
								),
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
									yield* needsSignIn(server, failure);
									yield* retire(server, live);
								}).pipe(server.lock.withPermits(1));
								return yield* refuse(signInHint(name, entry.config));
							}
							return yield* failed(failure.message);
						}
					});

			/** One call of one of the server's tools. A tool call is never retried after the server may have run it. */
			const call = (thread: Thread, name: string, tool: string) => (run: McpTool.Run) =>
				request(
					thread,
					name,
					(message) =>
						new ToolCallError({ server: name, tool, message: `MCP tool "${name}/${tool}" failed: ${message}` }),
				)(
					(connection) => connection.callTool({ name: tool, args: run.args, onProgress: run.onProgress }),
					(entry, server) =>
						McpTool.exposure(entry.config, tool) === "hidden" ||
						(server.live !== undefined && !server.tools.some((offered) => offered.name === tool))
							? `MCP tool "${name}/${tool}" is no longer available.`
							: undefined,
				);

			/** Servers the resource tools reach: enabled, connectable, offering resources, and not hidden for this thread. */
			const withResources = (entry: Entry) =>
				entry.server !== undefined &&
				!entry.server.stopped &&
				entry.server.resources &&
				exposureOf(entry.config) !== "hidden";

			const resourceServer = (thread: Thread, name: string): McpResources.Server => {
				const reach = request(
					thread,
					name,
					(message) =>
						new ToolCallError({
							server: name,
							tool: "resources",
							// Listings name the server beside each failure already.
							message,
						}),
				);
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
			const start = (server: Server) => {
				const ready = Deferred.makeUnsafe<void>();
				server.ready = ready;
				fork(open(server).pipe(Effect.ignore, Effect.ensuring(Deferred.succeed(ready, undefined))));
			};

			/** Close the instance once it has gone the idle timeout with no drain holding it. */
			const arm = (server: Server) => {
				server.generation += 1;
				if (server.leases > 0 || server.closed) return;
				const generation = server.generation;
				fork(
					Effect.sleep(idleTimeout).pipe(
						Effect.andThen(
							Effect.suspend(() =>
								server.leases === 0 && server.generation === generation && !server.closed
									? close(server).pipe(
											Effect.andThen(Effect.logInfo("mcp server idle, closed", { server: server.name })),
										)
									: Effect.void,
							),
						),
					),
				);
			};

			/** One more or one less drain holding the instance; the last one out starts its idle timer. */
			const hold = (server: Server, delta: number) => {
				server.leases += delta;
				arm(server);
			};

			/** The instances a thread uses, each once. */
			const used = (thread: Thread) =>
				new Set([...thread.servers.values()].flatMap((entry) => (entry.server ? [entry.server] : [])));

			/** The thread stops using these instances, and its drains stop holding them; returns the ones nobody uses now. */
			const leave = (thread: Thread, servers: Iterable<Server>) => {
				const unused: Server[] = [];
				for (const server of servers) {
					server.users.delete(thread.id);
					hold(server, -thread.leases);
					if (server.users.size === 0) unused.push(server);
				}
				return unused;
			};

			const threadOf = (threadId: ThreadId, sessionId: SessionId) => {
				let thread = threads.get(threadId);
				if (thread === undefined) {
					thread = {
						id: threadId,
						sessionId,
						leases: 0,
						servers: new Map(),
						names: McpTool.names(),
						lock: Semaphore.makeUnsafe(1),
						reported: new Set(),
						warnedUnreachable: false,
					};
					threads.set(threadId, thread);
				}
				return thread;
			};

			/** Every tool the thread's servers offer now, each with its exposure in the thread. */
			const toolsOf = (thread: Thread) => {
				// Every tool is registered with its exposure; the registry decides which ones are offered.
				const tools: RegisteredTool[] = [];
				const output = { save: McpOutput.save };
				// Resource tools follow their servers' exposure: declared when one of them is `direct`.
				const resourceTools = [...thread.servers.values()].some(
					(entry) => withResources(entry) && exposureOf(entry.config) === "direct",
				);
				for (const [name, entry] of thread.servers) {
					const server = entry.server;
					if (server === undefined || server.stopped || server.tools.length === 0) continue;
					const names = thread.names(
						name,
						server.tools.map((tool) => tool.name),
					);
					for (const tool of server.tools) {
						tools.push(
							McpTool.make({
								server: name,
								tool,
								name: names.get(tool.name)!,
								exposure: McpTool.exposure(entry.config, tool.name),
								call: call(thread, name, tool.name),
								// A resource link points to `read_mcp_resource` only when the model has it.
								content: { ...output, readable: resourceTools && withResources(entry) },
							}),
						);
					}
				}
				if (resourceTools)
					tools.push(
						...McpResources.make({
							servers: () =>
								[...thread.servers]
									.filter(([, entry]) => withResources(entry))
									.map(([name]) => resourceServer(thread, name)),
							// A server still connecting may offer resources once it has.
							ready: () =>
								Effect.forEach([...thread.servers.values()], ({ server }) => firstAttempt(server), {
									discard: true,
								}),
							content: output,
						}),
					);
				return tools;
			};

			/** The thread's enabled servers configured with `deferred` exposure. */
			const deferring = (thread: Thread) =>
				[...thread.servers.values()].flatMap(({ config, server }) =>
					server !== undefined && hasTools(config, "deferred") ? [server] : [],
				);

			/** Settles when the server's connect attempt in progress, if any, does. */
			const attempted = (server: Server) =>
				Effect.andThen(
					firstAttempt(server),
					Effect.suspend(() => (server.attempt === undefined ? Effect.void : Fiber.await(server.attempt))),
				);

			const deferred = (thread: Thread) =>
				Effect.gen(function* () {
					const servers = deferring(thread);
					if (servers.length > 0)
						yield* Effect.forEach(servers, attempted, { concurrency: "unbounded", discard: true }).pipe(
							Effect.timeoutOption(STARTUP_WAIT),
						);
					return toolsOf(thread).flatMap((tool) =>
						tool.definition.exposure === "deferred" ? [toAikitTool(tool.definition)] : [],
					);
				});

			const reconcile = Effect.fn("Mcp.reconcile")(function* (input: Input) {
				const thread = threadOf(input.threadId, input.sessionId);
				for (const error of input.errors ?? []) {
					if (thread.reported.has(error)) continue;
					thread.reported.add(error);
					yield* Effect.logWarning(`mcp config: ${error}`);
				}
				/** Where a server of this scope starts, the roots it is sent, and the key of its instances. */
				const placement = (scope: ServerConfig["scope"]) => {
					switch (scope ?? "session") {
						case "app":
							return { key: "app", cwd: options.hostCwd, roots: undefined };
						case "space": {
							const root = input.space.root;
							return {
								key: `space:${input.space.id}`,
								cwd: root ?? input.hostDir ?? options.hostCwd,
								roots: root === undefined ? undefined : [root],
							};
						}
						default:
							// Threads of a session at the same place share one; `cwd` and `roots` are in the key.
							return {
								key: `session:${input.sessionId}`,
								cwd: input.directory ?? input.hostDir ?? options.hostCwd,
								roots: input.directory === undefined ? undefined : [input.directory],
							};
					}
				};
				// A server that needed sign-in connects again once its credential changed: the user signed in,
				// in this process or another, and expects the next turn to have its tools. Only the instances
				// this thread's servers resolve to are checked.
				const signedIn = new Set<Server>();
				for (const [name, config] of input.servers) {
					if (config.enabled === false) continue;
					const where = placement(config.scope);
					const server = instances.get(instanceKey(where.key, name, config, where.cwd, where.roots));
					if (
						server !== undefined &&
						server.state === "authenticate" &&
						server.attempt === undefined &&
						!server.closed &&
						(yield* credential(server)) !== server.refused
					)
						signedIn.add(server);
				}
				const restart = new Set<Server>();
				const started: Array<readonly [string, Entry, Server]> = [];
				const created: Server[] = [];
				/** Running instances the thread joins, with the status published last when it joined. */
				const joined: Array<readonly [Server, string | undefined]> = [];
				const disabled: string[] = [];
				// All bookkeeping happens in one step, so an interrupted turn cannot leave an instance
				// counting a thread or a drain it no longer has; closing what nobody uses runs on its own.
				const closing = yield* Effect.sync(() => {
					const before = new Map(thread.servers);
					const previous = used(thread);
					thread.servers.clear();
					for (const [name, config] of input.servers) {
						if (config.enabled === false) {
							thread.servers.set(name, { config, server: undefined });
							const was = before.get(name);
							if (was === undefined || was.server !== undefined) disabled.push(name);
							continue;
						}
						const where = placement(config.scope);
						const key = instanceKey(where.key, name, config, where.cwd, where.roots);
						let server = instances.get(key);
						if (server === undefined || server.closed) {
							server = {
								name,
								config,
								key,
								cwd: where.cwd,
								roots: where.roots,
								state: "connecting",
								error: undefined,
								tools: [],
								skipped: undefined,
								resources: false,
								refused: undefined,
								live: undefined,
								attempt: undefined,
								ready: undefined,
								closed: false,
								stopped: false,
								published: undefined,
								lock: Semaphore.makeUnsafe(1),
								control: Semaphore.makeUnsafe(1),
								users: new Set(),
								leases: 0,
								generation: 0,
							};
							instances.set(key, server);
							created.push(server);
						} else {
							if (signedIn.has(server) && server.attempt === undefined) restart.add(server);
							if (!server.users.has(thread.id)) joined.push([server, server.published]);
						}
						const entry: Entry = { config, server };
						thread.servers.set(name, entry);
						if (before.get(name)?.server !== server || signedIn.has(server)) started.push([name, entry, server]);
						if (!server.users.has(thread.id)) {
							server.users.add(thread.id);
							hold(server, thread.leases);
						}
					}
					// Instances this thread no longer uses: a removed server, or changed settings.
					const current = used(thread);
					return leave(
						thread,
						[...previous].filter((server) => !current.has(server)),
					);
				}).pipe(thread.lock.withPermits(1));
				// A thread joining a running instance learns where it stands. Skipped when the instance has
				// published since it joined: that newer status already reached the thread, and this one would be stale.
				for (const [server, seen] of joined) yield* publishJoined(thread, server, seen);
				for (const server of closing) fork(close(server));
				// A new instance publishes from its first state on, to every thread using it by then.
				for (const server of created) start(server);
				for (const name of disabled) yield* publishTo([thread.id], { server: name, state: "disabled" });
				for (const server of restart) start(server);

				// Wait for servers this turn started using (all of them at first, then new or restarted ones)
				// so their tools are offered in its first request, but never indefinitely: one hanging server
				// must not hold up the prompt.
				const loaded = input.loaded ?? [];
				const pending = started.filter(
					([name, entry]) => hasTools(entry.config, "direct") || loadsFrom(name, loaded),
				);
				if (pending.length > 0) {
					const finished = yield* Effect.forEach(pending, ([, , server]) => firstAttempt(server), {
						concurrency: "unbounded",
						discard: true,
					}).pipe(Effect.timeoutOption(STARTUP_WAIT));
					if (finished._tag === "None")
						yield* Effect.logInfo("mcp servers are still connecting; their tools appear once connected");
				}

				// Until codemode exists, nothing reaches these tools; say so once.
				const unreachable = [...thread.servers.values()].some(
					(entry) => entry.server !== undefined && hasTools(entry.config, "codemode"),
				);
				if (unreachable && !thread.warnedUnreachable) {
					thread.warnedUnreachable = true;
					yield* Effect.logWarning(
						"MCP tools exposed to codemode are only reachable from the codemode tool, which is not active; they cannot be called.",
					);
				}
				return {
					tools: toolsOf(thread),
					defers: deferring(thread).length > 0,
					deferred: deferred(thread),
				} satisfies Reconciled;
			});

			const lease = (input: { readonly sessionId: SessionId; readonly threadId: ThreadId }) =>
				Effect.acquireRelease(
					Effect.sync(() => {
						const thread = threadOf(input.threadId, input.sessionId);
						thread.leases += 1;
						for (const server of used(thread)) hold(server, 1);
						return thread;
					}),
					(thread) =>
						Effect.sync(() => {
							thread.leases -= 1;
							for (const server of used(thread)) hold(server, -1);
							// Every thread drains, MCP or not; one with no servers and nothing reported has nothing worth keeping.
							if (
								thread.leases === 0 &&
								thread.servers.size === 0 &&
								thread.reported.size === 0 &&
								threads.get(thread.id) === thread
							)
								threads.delete(thread.id);
						}),
				).pipe(Effect.asVoid);

			/**
			 * Run `operation` on the instance behind the thread's server, one operation per instance at a
			 * time. A turn that moved the thread to another instance meanwhile makes the server unknown,
			 * so a stale status is never returned.
			 */
			const control = (threadId: ThreadId, name: string, operation: (server: Server) => Effect.Effect<void>) =>
				Effect.gen(function* () {
					const unknown = new UnknownServerError({ server: name, message: `unknown MCP server "${name}"` });
					const thread = threads.get(threadId);
					if (thread === undefined)
						return yield* new UnknownServerError({
							server: name,
							message: `thread ${threadId} has not started MCP server "${name}" yet; send it a message first`,
						});
					const entry = thread.servers.get(name);
					if (entry === undefined) return yield* unknown;
					const server = entry.server;
					if (server === undefined) return statusOf(name, entry);
					return yield* Effect.gen(function* () {
						// Only an idle timeout closes an instance a thread still uses; the next turn opens a new one.
						if (server.closed)
							return yield* new UnknownServerError({
								server: name,
								message: `MCP server "${name}" was closed while idle; the thread's next message starts it again`,
							});
						yield* operation(server);
						const current = threads.get(threadId)?.servers.get(name);
						if (current?.server !== server) return yield* unknown;
						return statusOf(name, current);
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

			const remove = Effect.fn("Mcp.remove")(function* (sessionId: SessionId) {
				for (const thread of threads.values()) {
					if (thread.sessionId !== sessionId) continue;
					const unused = yield* Effect.sync(() => {
						if (threads.get(thread.id) === thread) threads.delete(thread.id);
						const unused = leave(thread, used(thread));
						thread.servers.clear();
						return unused;
					}).pipe(thread.lock.withPermits(1));
					// Stopping can take seconds; deleting the session does not wait for it.
					for (const server of unused) fork(close(server));
				}
			});

			return Service.of({
				reconcile,
				lease,
				status: (threadId) =>
					Effect.sync(() =>
						[...(threads.get(threadId)?.servers ?? [])].map(([name, entry]) => statusOf(name, entry)),
					),
				settle: (threadId) =>
					Effect.forEach(
						[...(threads.get(threadId)?.servers.values() ?? [])],
						({ server }) => firstAttempt(server),
						{ discard: true, concurrency: "unbounded" },
					),
				connect,
				disconnect,
				remove,
			});
		}),
	);

/**
 * Connect each of `servers` once, apart from any session, and report how every one stands; a server
 * that cannot connect is reported, not failed. Its instances close with the calling scope's service.
 */
export const check = Effect.fn("Mcp.check")(function* (
	input: Pick<Input, "servers" | "directory" | "hostDir" | "errors">,
) {
	const mcp = yield* Service;
	// Servers checked outside a session run for a thread of their own.
	const sessionId = SessionId.create();
	const threadId = ThreadId.create();
	yield* mcp.reconcile({ ...input, sessionId, threadId, space: { id: sessionId, root: input.directory } });
	yield* mcp.settle(threadId);
	return yield* mcp.status(threadId);
});

export * as Mcp from "./mcp.ts";
