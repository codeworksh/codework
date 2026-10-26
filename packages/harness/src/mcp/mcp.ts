/**
 * The MCP servers sessions run, kept connected across their exchanges.
 *
 * A server's `scope` decides who shares a running instance of it: one session, every session in a
 * space, or the whole app. An instance is keyed by that scope and by everything its connection is
 * made from, so sessions that resolve different settings never share one.
 *
 * Every exchange hands over the session's servers as its `mcp` plugins left them ({@link
 * Interface.reconcile}); a session moves to a new instance when a server's connection settings
 * change, stops using one it no longer names, and new instances connect in the background. Exposure
 * stays the session's own: two sessions can share an instance and show the model different tools.
 *
 * A running drain holds a {@link Interface.lease} on its session's instances. An instance no session
 * uses any more closes at once; one no drain holds closes after an idle timeout. The tools an exchange registers are the ones the servers offered
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
import type { AuthProvider, Tool } from "@modelcontextprotocol/client";
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
import { ConnectError, type McpError, NeedsAuthError, ToolCallError, UnavailableError } from "./error.ts";
import type { ID as SessionId } from "../session/schema.ts";
import type { RegisteredTool } from "../tool/tool.ts";
import { McpClient } from "./client.ts";
import { McpLog } from "./log.ts";
import { McpOAuth } from "./oauth.ts";
import { McpOutput } from "./output.ts";
import { McpResources } from "./resources.ts";
import { McpTool } from "./tool.ts";
import { McpValue } from "./value.ts";
import { hostPath } from "../host.ts";
import { ModelCatalog } from "../model/catalog.ts";
import { expandTilde } from "../util/home.ts";

/** An exchange waits this long for the servers it started whose tools are declared to the model. */
const STARTUP_WAIT = Duration.seconds(10);
/** An instance no running drain holds closes after this long. */
const IDLE_TIMEOUT = Duration.minutes(10);
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
	 * Where a `session` server starts (its own relative `cwd` resolves against it), and the root sent
	 * to it: the session's directory when its sandbox is the host's own filesystem. Absent otherwise,
	 * since that directory does not exist here; servers then start in the session's host directory
	 * and are sent no roots.
	 */
	readonly directory?: string | undefined;
	/** The session's space; `root`, its folder, only when the space is on the host's own filesystem. */
	readonly space: { readonly id: string; readonly root?: string | undefined };
	readonly hostDir?: string | undefined;
	/** Configuration problems from `mcp.json`, reported once per session. */
	readonly errors?: ReadonlyArray<string>;
}

export interface Interface {
	/** Settle a session's servers for its next exchange, and return the tools that exchange declares. */
	readonly reconcile: (input: Input) => Effect.Effect<ReadonlyArray<RegisteredTool>>;
	/** Keep the session's instances open for as long as the calling scope, a drain, runs. */
	readonly lease: (sessionId: SessionId) => Effect.Effect<void, never, Scope.Scope>;
	readonly status: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<Status>>;
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

/** One running instance of a server, shared by the sessions whose servers resolve to its key. */
interface Server {
	readonly name: string;
	/** The config it was started with. Exposure is read from each session's own config instead. */
	readonly config: ServerConfig;
	/** The scope and everything a connection is made from. */
	readonly key: string;
	readonly cwd: string;
	readonly roots: ReadonlyArray<string> | undefined;
	state: State;
	error: string | undefined;
	tools: ReadonlyArray<Tool>;
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
	readonly lock: Semaphore.Semaphore;
	/** Sessions whose servers resolve to this instance. */
	readonly users: Set<SessionId>;
	/** Drains holding it open. */
	leases: number;
	/** Bumped whenever the lease count changes, so an idle timer can tell it went stale. */
	generation: number;
}

/** One of a session's servers: its own config, and the instance it resolves to unless disabled. */
interface Entry {
	readonly config: ServerConfig;
	readonly server: Server | undefined;
}

interface Session {
	readonly id: SessionId;
	readonly servers: Map<string, Entry>;
	readonly names: ReturnType<typeof McpTool.names>;
	readonly lock: Semaphore.Semaphore;
	readonly reported: Set<string>;
	/** Whether the session was told its `codemode` or `deferred` tools cannot be reached. */
	warnedUnreachable: boolean;
	/** Running drains of this session. */
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
 * session's servers map one to one onto the instances it uses.
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

const hasDirectTools = (config: ServerConfig) =>
	exposureOf(config) === "direct" ||
	Object.values(config.toolExposure ?? {}).some((exposure) => exposure === "direct");

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
			// Connections close in parallel on shutdown, so one slow server's stop grace does not hold up
			// the rest. Made before the fibers below, so connect attempts are interrupted before it closes.
			const servers = yield* Scope.fork(root, "parallel");
			const fork = yield* FiberSet.makeRuntime<never, void, never>();
			const forkAttempt = yield* FiberSet.makeRuntime<never, Live, ConnectError>();
			const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
			const log = yield* McpLog.make(hostPath.join(options.home, "mcp.log"));
			const oauth = McpOAuth.store(options.home);
			const sessions = new Map<SessionId, Session>();
			const instances = new Map<string, Server>();
			const idleTimeout = options.idleTimeout ?? IDLE_TIMEOUT;
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
					server.state = "needs-auth";
					server.error = signInHint(server.name, server.config);
					server.refused = yield* credential(server);
					const target = oauthServer(server);
					if (target !== undefined && error.scope !== undefined)
						yield* McpOAuth.remember(oauth, target, {
							scope: error.scope,
							resourceMetadataUrl: error.resourceMetadataUrl,
							error: "insufficient_scope",
						}).pipe(Effect.ignore);
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
				// Listed without the server's lock, which calls and closing need: the listing can take a while.
				// Listings can finish out of order; only the latest one counts.
				live.connection.onToolsChanged(
					Effect.sync(() => {
						const refresh = ++live.refreshes;
						const latest = () => server.live === live && live.refreshes === refresh;
						fork(
							live.connection.tools().pipe(
								Effect.match({
									onSuccess: (tools) => {
										if (latest()) server.tools = tools;
									},
									onFailure: (error) => {
										if (latest()) server.error = `failed to refresh tools: ${error.message}`;
									},
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
						yield* Effect.logWarning("mcp connect failed", { server: server.name, error: message });
						if (Schema.is(NeedsAuthError)(error)) {
							yield* needsSignIn(server, error);
							return yield* new ConnectError({ server: server.name, message: server.error! });
						}
						server.state = "failed";
						server.error = message;
						return yield* new ConnectError({ server: server.name, message });
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
			const open = (server: Server): Effect.Effect<Live, ConnectError | UnavailableError> =>
				Effect.gen(function* () {
					const shutDown = new UnavailableError({
						server: server.name,
						message: `MCP server "${server.name}" is shut down`,
					});
					const next = yield* Effect.gen(function* () {
						if (server.closed) return yield* shutDown;
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
					return yield* Cause.hasInterruptsOnly(exit.cause) ? Effect.fail(shutDown) : Effect.failCause(exit.cause);
				});

			/** Stop the instance: interrupt a connect in progress, and retire the connection it has. */
			const close = (server: Server) =>
				Effect.gen(function* () {
					if (instances.get(server.key) === server) instances.delete(server.key);
					server.closed = true;
					const pending = server.attempt;
					if (pending !== undefined) yield* Fiber.interrupt(pending);
					yield* Effect.suspend(() =>
						server.live === undefined ? Effect.void : retire(server, server.live),
					).pipe(server.lock.withPermits(1));
				});

			/**
			 * One request on whichever connection of the server is current when it runs. `what` names
			 * it in a failure. A request the server never saw, because it had forgotten the session,
			 * runs once more on a new one; nothing else is retried here.
			 */
			const request =
				(session: Session, name: string, failed: (message: string) => ToolCallError) =>
				<A>(
					run: (connection: McpClient.Connection) => Effect.Effect<A, McpClient.Failed>,
					/** Why the server, as it stands, no longer offers what is asked; checked before every attempt. */
					unavailable: (entry: Entry, server: Server) => string | undefined = () => undefined,
				): Effect.Effect<A, McpError.Failure> =>
					Effect.gen(function* () {
						const refuse = (message: string) => new UnavailableError({ server: name, message });
						for (let attempt = 1; ; attempt++) {
							const entry = session.servers.get(name);
							const server = entry?.server;
							if (entry === undefined || server === undefined || server.closed)
								return yield* refuse(`MCP server "${name}" is disabled.`);
							const reason = unavailable(entry, server);
							if (reason !== undefined) return yield* refuse(reason);
							const live = yield* open(server).pipe(
								// A server that needs sign-in says how to sign in, which is all the model can pass on.
								Effect.mapError((error) =>
									refuse(
										server.state === "needs-auth"
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
			const call = (session: Session, name: string, tool: string) => (run: McpTool.Run) =>
				request(
					session,
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

			/** Servers the resource tools reach: enabled, offering resources, and not hidden for this session. */
			const withResources = (entry: Entry) =>
				entry.server !== undefined && entry.server.resources && (entry.config.exposure ?? "direct") !== "hidden";

			const resourceServer = (session: Session, name: string): McpResources.Server => {
				const reach = request(
					session,
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

			/** The instances a session uses, each once. */
			const used = (session: Session) =>
				new Set([...session.servers.values()].flatMap((entry) => (entry.server ? [entry.server] : [])));

			const sessionOf = (sessionId: SessionId) => {
				let session = sessions.get(sessionId);
				if (session === undefined) {
					session = {
						id: sessionId,
						leases: 0,
						servers: new Map(),
						names: McpTool.names(),
						lock: Semaphore.makeUnsafe(1),
						reported: new Set(),
						warnedUnreachable: false,
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
							return {
								key: `session:${input.sessionId}`,
								cwd: input.directory ?? input.hostDir ?? options.hostCwd,
								roots: input.directory === undefined ? undefined : [input.directory],
							};
					}
				};
				// A server that needed sign-in connects again once its credential changed: the user signed in,
				// in this process or another, and expects the next exchange to have its tools.
				const signedIn = new Set<Server>();
				for (const server of instances.values())
					if (
						server.state === "needs-auth" &&
						server.attempt === undefined &&
						!server.closed &&
						(yield* credential(server)) !== server.refused
					)
						signedIn.add(server);
				const started: Array<readonly [Entry, Server]> = [];
				// All bookkeeping happens in one step, so an interrupted exchange cannot leave an instance
				// counting a session or a drain it no longer has; closing what nobody uses runs on its own.
				const closing = yield* Effect.sync(() => {
					const before = new Map(session.servers);
					const previous = used(session);
					session.servers.clear();
					for (const [name, config] of input.servers) {
						if (config.enabled === false) {
							session.servers.set(name, { config, server: undefined });
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
								resources: false,
								refused: undefined,
								live: undefined,
								attempt: undefined,
								ready: undefined,
								closed: false,
								lock: Semaphore.makeUnsafe(1),
								users: new Set(),
								leases: 0,
								generation: 0,
							};
							instances.set(key, server);
							start(server);
						} else if ((server.state === "failed" || signedIn.has(server)) && server.attempt === undefined) {
							// A server that could not connect declares no tools, so no call would retry it, and
							// shared instances would keep every later session on it. Retry in the background;
							// waiting would hold up every prompt while it is down.
							start(server);
						}
						const entry: Entry = { config, server };
						session.servers.set(name, entry);
						if (before.get(name)?.server !== server || signedIn.has(server)) started.push([entry, server]);
						if (!server.users.has(session.id)) {
							server.users.add(session.id);
							hold(server, session.leases);
						}
					}
					// Instances this session no longer uses: a removed server, or changed settings.
					const current = used(session);
					const unused: Server[] = [];
					for (const server of previous) {
						if (current.has(server)) continue;
						server.users.delete(session.id);
						hold(server, -session.leases);
						if (server.users.size === 0) unused.push(server);
					}
					return unused;
				}).pipe(session.lock.withPermits(1));
				for (const server of closing) fork(close(server));

				// Wait for servers this exchange started (all of them at first, then new or restarted ones) so
				// their tools are declared in its first request, but never indefinitely: one hanging server
				// must not hold up the prompt.
				const pending = started.filter(([entry]) => hasDirectTools(entry.config));
				if (pending.length > 0) {
					const finished = yield* Effect.forEach(pending, ([, server]) =>
						server.ready === undefined ? Effect.void : Deferred.await(server.ready),
					).pipe(Effect.timeoutOption(STARTUP_WAIT));
					if (finished._tag === "None")
						yield* Effect.logInfo("mcp servers are still connecting; their tools appear once connected");
				}

				const tools: RegisteredTool[] = [];
				// Until codemode and `tool_search` exist, nothing reaches these tools; say so once.
				const unreachable = [...session.servers.values()].some(
					(entry) =>
						entry.server !== undefined &&
						[exposureOf(entry.config), ...Object.values(entry.config.toolExposure ?? {})].some(
							(exposure) => exposure === "codemode" || exposure === "deferred",
						),
				);
				if (unreachable && !session.warnedUnreachable) {
					session.warnedUnreachable = true;
					yield* Effect.logWarning(
						"MCP tools are only reachable from the codemode or tool_search tool, but neither is active; they cannot be called.",
					);
				}
				const output = { save: McpOutput.save };
				// Resource tools follow their servers' exposure: declared when one of them is `direct`.
				const resourceTools = [...session.servers.values()].some(
					(entry) => withResources(entry) && exposureOf(entry.config) === "direct",
				);
				for (const [name, entry] of session.servers) {
					const server = entry.server;
					if (server === undefined || server.tools.length === 0) continue;
					const names = session.names(
						name,
						server.tools.map((tool) => tool.name),
					);
					for (const tool of server.tools) {
						if (McpTool.exposure(entry.config, tool.name) !== "direct") continue;
						tools.push(
							McpTool.make({
								server: name,
								tool,
								name: names.get(tool.name)!,
								call: call(session, name, tool.name),
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
								[...session.servers]
									.filter(([, entry]) => withResources(entry))
									.map(([name]) => resourceServer(session, name)),
							// A server still connecting may offer resources once it has.
							ready: () =>
								Effect.forEach(
									[...session.servers.values()],
									({ server }) => (server?.ready === undefined ? Effect.void : Deferred.await(server.ready)),
									{ discard: true },
								),
							content: output,
						}),
					);
				return tools;
			});

			const lease = (sessionId: SessionId) =>
				Effect.acquireRelease(
					Effect.sync(() => {
						const session = sessionOf(sessionId);
						session.leases += 1;
						for (const server of used(session)) hold(server, 1);
						return session;
					}),
					(session) =>
						Effect.sync(() => {
							session.leases -= 1;
							for (const server of used(session)) hold(server, -1);
							// Every session drains, MCP or not; one with no servers has nothing worth keeping.
							if (session.leases === 0 && session.servers.size === 0 && sessions.get(session.id) === session)
								sessions.delete(session.id);
						}),
				).pipe(Effect.asVoid);

			return Service.of({
				reconcile,
				lease,
				status: (sessionId) =>
					Effect.sync(() =>
						[...(sessions.get(sessionId)?.servers ?? [])].map(([name, { server }]) => ({
							server: name,
							state: server === undefined ? "disabled" : server.closed ? "disconnected" : server.state,
							...(server?.error === undefined ? {} : { error: server.error }),
							tools: server?.tools.length ?? 0,
						})),
					),
			});
		}),
	);

export * as Mcp from "./mcp.ts";
