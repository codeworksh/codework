import { pathToFileURL } from "node:url";
import {
	type CallToolResult,
	Client,
	type Implementation,
	type OAuthClientProvider,
	ProtocolError,
	ProtocolErrorCode,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	type ReadResourceResult,
	SdkError,
	SdkErrorCode,
	SdkHttpError,
	type ServerCapabilities,
	StreamableHTTPClientTransport,
	type Tool,
	type Transport,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import { Cause, Clock, Data, Duration, Effect, Exit, FiberSet, Schedule } from "effect";
import { hostPath } from "../host.ts";
import { ConnectError, NeedsAuthError, RequestError, SessionExpiredError } from "./error.ts";
import { McpStdio } from "./stdio.ts";

const DEFAULT_STARTUP_TIMEOUT = Duration.seconds(30);
const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(60);
const TERMINATE_TIMEOUT = Duration.seconds(1);

export interface Stdio {
	readonly _tag: "Stdio";
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly env: Record<string, string>;
	readonly cwd: string;
}

export interface Http {
	readonly _tag: "Http";
	readonly url: URL;
	readonly headers: Record<string, string>;
}

export type Endpoint = Stdio | Http;

export interface Progress {
	readonly progress: number;
	readonly total?: number | undefined;
	readonly message?: string | undefined;
}

type Failed = RequestError | SessionExpiredError | NeedsAuthError;

/** Handle over a connected MCP server that keeps the SDK `Client` out of the rest of the harness. */
export interface Connection {
	readonly serverInfo: Implementation | undefined;
	readonly capabilities: ServerCapabilities | undefined;
	readonly instructions: string | undefined;
	/** Every tool, following pagination. Empty when the server has no tools capability. */
	readonly tools: () => Effect.Effect<Tool[], Failed>;
	/** One page of resources, starting at `cursor`. Empty when the server has no resources capability. */
	readonly resources: (cursor?: string) => Effect.Effect<ListResourcesResult, Failed>;
	/** One page of resource templates; empty when the server does not implement the method. */
	readonly resourceTemplates: (cursor?: string) => Effect.Effect<ListResourceTemplatesResult, Failed>;
	readonly readResource: (uri: string) => Effect.Effect<ReadResourceResult, Failed>;
	readonly callTool: (input: {
		readonly name: string;
		readonly args?: Record<string, unknown>;
		readonly onProgress?: (progress: Progress) => void;
	}) => Effect.Effect<CallToolResult, Failed>;
	/** Each handler has one consumer (the owner of this connection); setting it again replaces it. */
	readonly onToolsChanged: (handler: Effect.Effect<void>) => void;
	readonly onResourcesChanged: (handler: Effect.Effect<void>) => void;
	readonly onSessionExpired: (handler: Effect.Effect<void>) => void;
	/**
	 * The connection dropped (for example the server process exited). Runs right away when it already
	 * dropped before the handler was set. Never runs for a close caused by closing the owning scope.
	 */
	readonly onClose: (handler: (reason: string) => Effect.Effect<void>) => void;
}

export interface ConnectInput {
	readonly server: string;
	readonly endpoint: Endpoint;
	/** Directories sent as roots; only when the session's sandbox is local, where these paths exist for the server. */
	readonly roots?: ReadonlyArray<string>;
	/** HTTP only. */
	readonly authProvider?: OAuthClientProvider;
	readonly timeout?: { readonly startup?: Duration.Input; readonly request?: Duration.Input };
	readonly clientInfo?: Implementation;
}

/** A raw SDK or transport failure, before it is mapped to one of the public errors. */
class Failure extends Data.TaggedError("Mcp.Failure")<{ readonly error: unknown }> {}
const fail = (error: unknown) => new Failure({ error });

// Node's fetch reports network failures as `TypeError("fetch failed")` with the system code on `cause`.
const systemCode = (error: Error): string | undefined => {
	const code =
		(error as { readonly code?: unknown }).code ?? (error.cause as { readonly code?: unknown } | undefined)?.code;
	return typeof code === "string" ? code : undefined;
};

// HTTP statuses and network error codes live on error properties and are lost once flattened to a message.
const describe = (error: unknown) => {
	if (!(error instanceof Error)) return String(error);
	const detail =
		error instanceof SdkHttpError
			? `HTTP ${error.status}`
			: !(error instanceof SdkError)
				? systemCode(error)
				: undefined;
	return detail && !error.message.includes(detail) ? `${error.message} (${detail})` : error.message;
};

// Overloaded or restarting servers and dropped connections usually recover within a second.
// 501 means the server will never support the request.
const isTransient = (error: unknown) =>
	error instanceof SdkHttpError
		? error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501)
		: error instanceof TypeError;

/** Connects one MCP server; closing the calling scope tears down the transport and any spawned process. */
export const connect = Effect.fnUntraced(function* (input: ConnectInput) {
	const { server, endpoint } = input;
	const startupTimeout = Duration.toMillis(input.timeout?.startup ?? DEFAULT_STARTUP_TIMEOUT);
	const requestTimeout = Duration.toMillis(input.timeout?.request ?? DEFAULT_REQUEST_TIMEOUT);
	const runFork = yield* FiberSet.makeRuntime<never, void, never>();

	// Handlers the owner registers after connect; notifications can arrive before that.
	const handlers = {
		tools: Effect.void as Effect.Effect<void>,
		resources: Effect.void as Effect.Effect<void>,
		expired: Effect.void as Effect.Effect<void>,
	};
	// Every connect attempt builds its own client; only the one that connected reports a close.
	const closed: {
		shuttingDown: boolean;
		active?: Client | undefined;
		reason?: string | undefined;
		handler?: ((reason: string) => Effect.Effect<void>) | undefined;
	} = { shuttingDown: false };
	const early = new Map<Client, string>();
	const report = (reason: string) => {
		if (closed.reason !== undefined) return;
		closed.reason = reason;
		if (closed.handler) runFork(closed.handler(reason));
	};

	// The SDK fails pending requests with a bare "Connection closed"; the transport error before it says why.
	let lastError: string | undefined;
	const explain = (error: unknown) =>
		error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed && lastError
			? `${describe(error)}: ${lastError}`
			: describe(error);
	// A server that wants (new) credentials. Without an auth provider a 401 is a configuration error.
	const needsAuth = (error: unknown) =>
		error instanceof UnauthorizedError ||
		(input.authProvider !== undefined && error instanceof SdkHttpError && error.status === 401);

	// Two more attempts, 250 ms and 1 s later, while the failure is transient and the deadline has not passed.
	const retrying = <A>(what: string, effect: Effect.Effect<A, Failure>, deadline = Infinity) =>
		Effect.retry(
			effect,
			Schedule.max([Schedule.exponential("250 millis", 4), Schedule.recurs(2)]).pipe(
				Schedule.setInputType<Failure>(),
				Schedule.while(({ input, now, duration }) =>
					!isTransient(input.error) || now + Duration.toMillis(duration) >= deadline
						? Effect.succeed(false)
						: Effect.logWarning(`retrying ${what}`, { server, error: describe(input.error) }).pipe(
								Effect.as(true),
							),
				),
			),
		);

	const initialize = Effect.fnUntraced(function* (transport: Transport, timeout: number) {
		const client = new Client(input.clientInfo ?? { name: "codework", version: "unknown" }, {
			capabilities: input.roots ? { roots: {} } : {},
		});
		// Background work such as the standalone SSE stream reports failures only here; aborts come from close.
		client.onerror = (error) => {
			if (error.name === "AbortError") return;
			lastError = describe(error);
			runFork(Effect.logWarning("mcp transport error", { server, error: lastError }));
		};
		client.onclose = () => {
			if (closed.shuttingDown) return;
			const reason = lastError ? `connection closed: ${lastError}` : "connection closed";
			// Before connect returns, a close belongs to an attempt that may still fail and be retried.
			if (closed.active === client) report(reason);
			else if (!early.has(client)) early.set(client, reason);
		};
		// Handled whether or not the server advertises `listChanged`, since some servers send them anyway.
		client.setNotificationHandler("notifications/tools/list_changed", () => {
			runFork(handlers.tools);
		});
		client.setNotificationHandler("notifications/resources/list_changed", () => {
			runFork(handlers.resources);
		});
		const roots = input.roots;
		if (roots) {
			client.setRequestHandler("roots/list", () => ({
				roots: roots.map((directory) => ({
					uri: pathToFileURL(directory).href,
					name: hostPath.basename(directory),
				})),
			}));
		}
		yield* Effect.tryPromise({
			try: (signal) => client.connect(transport, { timeout, signal }),
			catch: fail,
		}).pipe(Effect.onError(() => Effect.promise(() => transport.close()).pipe(Effect.ignore)));
		return client;
	});

	// The transport holds the Mcp-Session-Id the server minted, and the server answering it with 404, or
	// with the 400 a freshly restarted single-session server emits, means it no longer knows this
	// connection. Other 400s pass through untouched.
	const session: { transport?: StreamableHTTPClientTransport; reported: boolean } = { reported: false };
	const failure =
		(method: string) =>
		(error: unknown): Failed => {
			if (needsAuth(error)) return new NeedsAuthError({ server, message: describe(error) });
			const request = () => new RequestError({ server, method, message: explain(error) });
			if (!(error instanceof SdkHttpError) || session.transport?.sessionId === undefined) return request();
			const text = (error.data as { readonly text?: unknown }).text;
			const expired =
				error.status === 404 ||
				(error.status === 400 && typeof text === "string" && text.includes("Bad Request: Server not initialized"));
			if (!expired) return request();
			if (!session.reported) {
				session.reported = true;
				runFork(handlers.expired);
			}
			return new SessionExpiredError({ server });
		};

	let stderr = () => "";
	const exit = yield* Effect.gen(function* () {
		if (endpoint._tag === "Stdio") {
			const stdio = yield* McpStdio.make({
				server,
				command: endpoint.command,
				args: endpoint.args,
				cwd: endpoint.cwd,
				env: endpoint.env,
			});
			stderr = stdio.stderr;
			return yield* initialize(stdio.transport, startupTimeout);
		}
		// Every attempt opens a fresh transport and gets what is left of the startup timeout.
		const deadline = (yield* Clock.currentTimeMillis) + startupTimeout;
		const open = Effect.gen(function* () {
			const remaining = Math.max(1, deadline - (yield* Clock.currentTimeMillis));
			session.transport = new StreamableHTTPClientTransport(endpoint.url, {
				requestInit: { headers: endpoint.headers },
				...(input.authProvider === undefined ? {} : { authProvider: input.authProvider }),
			});
			return yield* initialize(session.transport, remaining);
		});
		return yield* retrying("mcp connect", open, deadline);
	}).pipe(Effect.exit);

	if (Exit.isFailure(exit)) {
		const squashed = Cause.squash(exit.cause);
		const error = squashed instanceof Failure ? squashed.error : squashed;
		if (needsAuth(error)) return yield* new NeedsAuthError({ server, message: describe(error) });
		// A server that fails to start usually says why on stderr.
		const message = explain(error);
		const tail = stderr().trim();
		return yield* new ConnectError({
			server,
			message: tail && !message.includes(tail) ? `${message}\n${tail}` : message,
		});
	}

	const client = exit.value;
	closed.active = client;
	// The server closed between the handshake finishing and this point.
	const dropped = early.get(client);
	early.clear();
	if (dropped !== undefined) report(dropped);
	yield* Effect.addFinalizer(() =>
		Effect.gen(function* () {
			closed.shuttingDown = true;
			// Close only aborts streams; the HTTP session lives on until the server expires it unless
			// terminated explicitly. Terminate first: close aborts the signal the DELETE shares.
			const transport = session.transport;
			// Termination failures are logged below; onerror would report them a second time.
			client.onerror = () => {};
			if (transport?.sessionId !== undefined && !session.reported)
				yield* Effect.tryPromise({ try: () => transport.terminateSession(), catch: fail }).pipe(
					Effect.timeoutOrElse({
						duration: TERMINATE_TIMEOUT,
						orElse: () => Effect.fail(fail(`timed out after ${Duration.format(TERMINATE_TIMEOUT)}`)),
					}),
					Effect.tapError((failure) =>
						Effect.logWarning("failed to terminate mcp session", { server, error: describe(failure.error) }),
					),
					Effect.ignore,
				);
			yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore);
		}),
	);

	// A success means transport errors from before the request no longer explain a later close. One
	// that arrived meanwhile (a crash while other requests are pending) is kept.
	const succeeded = (before: string | undefined) =>
		Effect.sync(() => {
			if (lastError === before) lastError = undefined;
		});
	const request = <A>(method: string, run: (signal: AbortSignal) => Promise<A>) =>
		Effect.suspend(() => {
			const before = lastError;
			return Effect.tryPromise({ try: run, catch: failure(method) }).pipe(Effect.tap(succeeded(before)));
		});
	// Listing and reading are read-only, so a transient failure is safe to retry. Tool calls are never
	// retried: the server may already have run them.
	const read = <A>(method: string, run: (signal: AbortSignal) => Promise<A>) =>
		Effect.suspend(() => {
			const before = lastError;
			return retrying(method, Effect.tryPromise({ try: run, catch: fail })).pipe(
				Effect.mapError((error) => failure(method)(error.error)),
				Effect.tap(succeeded(before)),
			);
		});
	// Every progress notification restarts the timeout, so long calls that report progress keep running.
	const options = (signal: AbortSignal, onProgress?: (progress: Progress) => void) => ({
		signal,
		timeout: requestTimeout,
		resetTimeoutOnProgress: true,
		onprogress: onProgress ?? (() => {}),
	});
	const capabilities = client.getServerCapabilities();

	const connection: Connection = {
		serverInfo: client.getServerVersion(),
		capabilities,
		instructions: client.getInstructions()?.trim() || undefined,
		tools: () =>
			// Servers without the tools capability (prompts or resources only) do not answer tools/list.
			capabilities?.tools === undefined
				? Effect.succeed([])
				: read("tools/list", (signal) => client.listTools(undefined, options(signal))).pipe(
						Effect.map((result) => result.tools),
					),
		resources: (cursor) =>
			capabilities?.resources === undefined
				? Effect.succeed({ resources: [] })
				: read("resources/list", (signal) =>
						client.request(
							{ method: "resources/list", params: cursor === undefined ? {} : { cursor } },
							options(signal),
						),
					),
		resourceTemplates: (cursor) =>
			capabilities?.resources === undefined
				? Effect.succeed({ resourceTemplates: [] })
				: read("resources/templates/list", (signal) =>
						client
							.request(
								{ method: "resources/templates/list", params: cursor === undefined ? {} : { cursor } },
								options(signal),
							)
							.catch((error: unknown) => {
								// Servers that do not implement templates have none.
								if (error instanceof ProtocolError && error.code === ProtocolErrorCode.MethodNotFound)
									return { resourceTemplates: [] };
								throw error;
							}),
					),
		readResource: (uri) => read("resources/read", (signal) => client.readResource({ uri }, options(signal))),
		callTool: (call) =>
			request("tools/call", (signal) =>
				client.callTool({ name: call.name, arguments: call.args ?? {} }, options(signal, call.onProgress)),
			),
		onToolsChanged: (handler) => {
			handlers.tools = handler;
		},
		onResourcesChanged: (handler) => {
			handlers.resources = handler;
		},
		onSessionExpired: (handler) => {
			handlers.expired = handler;
		},
		onClose: (handler) => {
			closed.handler = handler;
			if (closed.reason !== undefined) runFork(handler(closed.reason));
		},
	};
	return connection;
});

export * as McpClient from "./client.ts";
