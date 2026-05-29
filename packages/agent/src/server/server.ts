import { H3, type H3Event, type HTTPError, onError, serve } from "h3";
import { lazy, NamedError, Filesystem, iife } from "@codeworksh/utils";
import { type Sandbox } from "../sandbox/sandbox";
import { WorkspaceContext } from "../workspace/context";
import { Instance } from "../project/instance";
import { InstanceBootstrap } from "../project/bootstrap";
import { namedErrorResponse } from "./error";
import { OpenAPI } from "./openapi";
import { SessionRoutes } from "./routes/session";
import { createLocalNodeEnv, createInMemoryEphemeralEnv } from "../sandbox/builtin";
import { GlobalBus } from "../streaming/global";
import { Log } from "../util/log";

export namespace Server {
	const log = Log.create({ service: "server" });
	const streamNextOffsetHeader = "Stream-Next-Offset";
	const streamClosedHeader = "Stream-Closed";
	const encoder = new TextEncoder();

	interface AppOptions {
		exposeUnhandledErrorDetails?: boolean;
	}
	export interface CodeWorkInitContext {
		workspaceId: string;
		sandbox: Sandbox.Env;
	}

	type ServerInstance = ReturnType<typeof serve>;
	type ListeningServer = ServerInstance & { url: string };

	function getErrorCause(error: HTTPError) {
		return error.cause instanceof Error ? error.cause : error;
	}

	function getErrorMessage(error: unknown, options: AppOptions) {
		if (!options.exposeUnhandledErrorDetails) return "Internal server error";
		if (error instanceof Error) return error.stack || error.message;
		return String(error);
	}

	function getErrorResponse(error: HTTPError, _event: H3Event, options: AppOptions) {
		const cause = getErrorCause(error);
		console.error(cause);

		if (cause instanceof NamedError) {
			return namedErrorResponse(cause);
		}

		if (!error.unhandled) {
			return Response.json(error.toJSON(), {
				headers: error.headers,
				status: error.status,
			});
		}

		return Response.json(new NamedError.Unknown({ message: getErrorMessage(cause, options) }).toObject(), {
			status: 500,
		});
	}

	function encodeSSE(payload: unknown) {
		return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
	}

	async function events(event: H3Event) {
		log.info("event connected");
		const url = new URL(event.req.url);
		const handle = await GlobalBus.reader({
			topic: "events",
		});
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				let offset = url.searchParams.get("offset") ?? "now";
				let closed = false;
				let heartbeat: ReturnType<typeof setInterval> | undefined;
				const dispose = () => {
					closed = true;
					if (heartbeat) clearInterval(heartbeat);
					event.req.signal.removeEventListener("abort", close);
				};
				const close = () => {
					if (closed) return;
					dispose();
					try {
						controller.close();
					} catch {
						// The client can cancel before our loop observes it.
					}
				};
				const fail = (error: unknown) => {
					if (closed) return;
					dispose();
					try {
						controller.error(error);
					} catch {
						// The stream may already be canceled by the client.
					}
				};
				const write = (payload: unknown) => {
					if (closed) return false;
					try {
						controller.enqueue(encodeSSE(payload));
						return true;
					} catch {
						dispose();
						return false;
					}
				};
				event.req.signal.addEventListener("abort", close, { once: true });
				heartbeat = setInterval(() => {
					write({
						type: "server.heartbeat",
						properties: {},
					});
				}, 10_000);

				try {
					write({
						type: "server.connected",
						properties: {},
					});

					while (!event.req.signal.aborted && !closed) {
						const streamUrl = new URL(handle.url);
						streamUrl.searchParams.set("offset", offset);
						streamUrl.searchParams.set("live", "long-poll");

						const response = await handle.fetch(streamUrl, {
							signal: event.req.signal,
						});
						offset = response.headers.get(streamNextOffsetHeader) ?? offset;

						if (response.status === 204) {
							if (response.headers.get(streamClosedHeader) === "true") break;
							continue;
						}
						if (!response.ok) {
							throw new Error(await response.text());
						}

						const messages = (await response.json()) as unknown[];
						for (const message of messages) {
							if (closed) break;
							if (!write(message)) break;
							if (
								typeof message === "object" &&
								message !== null &&
								"type" in message &&
								message.type === GlobalBus.InstanceDisposed.type
							) {
								close();
							}
						}
					}
					if (!closed) close();
				} catch (error) {
					if (!event.req.signal.aborted) fail(error);
				} finally {
					dispose();
					log.info("event disconnected");
				}
			},
		});

		return new Response(body, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				"x-accel-buffering": "no",
				"x-content-type-options": "nosniff",
			},
		});
	}

	function createApp(options: AppOptions = {}) {
		return new H3()
			.use(onError((error, event) => getErrorResponse(error, event, options)))
			.get("/openapi.json", () => OpenAPI.document())
			.use(async (event, next) => {
				const url = new URL(event.req.url);
				if (url.pathname === "/openapi.json") return next();

				const initContext = event.context.initContext;
				const workspaceId =
					initContext?.workspaceId ??
					url.searchParams.get("workspace") ??
					event.req.headers.get("x-codework-workspace") ??
					"local";

				const sandbox: Sandbox.Env =
					initContext?.sandbox ??
					(await iife(async () => {
						const sandboxId =
							url.searchParams.get("sandbox") || event.req.headers.get("x-codework-sandbox") || "local";
						const raw =
							url.searchParams.get("directory") ||
							event.req.headers.get("x-codework-directory") ||
							process.cwd();

						const directory = Filesystem.resolve(
							(() => {
								try {
									return decodeURIComponent(raw);
								} catch {
									return raw;
								}
							})(),
						);

						switch (sandboxId) {
							case "local":
								return await createLocalNodeEnv(directory);
							case "empty":
								return await createInMemoryEphemeralEnv();
							default:
								return await createInMemoryEphemeralEnv();
						}
					}));

				return WorkspaceContext.provide({
					workspaceId,
					sandbox,
					async fn() {
						return Instance.provide({
							id: sandbox.id,
							directory: sandbox.cwd,
							init: InstanceBootstrap,
							async fn() {
								try {
									return await next();
								} finally {
									if (!initContext && sandbox.ephemeral) {
										await Instance.dispose();
										await sandbox.cleanup();
									}
								}
							},
						});
					},
				});
			})
			.get("/events", events)
			.mount("/sessions", SessionRoutes())
			.get("/", (_event) => "⚡️ Tadaa!");
	}

	export const App: () => H3 = lazy(() => createApp());

	export const LocalApp: () => H3 = lazy(() => createApp({ exposeUnhandledErrorDetails: true }));

	function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
		return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
	}

	export async function listen(opts: { port: number; hostname: string }): Promise<ListeningServer> {
		const args = {
			hostname: opts.hostname,
			silent: true,
		} as const;

		const startServer = async (port: number) => {
			let server: ServerInstance | undefined;
			try {
				server = serve(App(), { ...args, port });
				server.node?.server?.setTimeout(0);
				await server.ready();
				if (!server.url) throw new Error(`failed to resolve server url for port: ${port}`);

				return server as ListeningServer;
			} catch (error) {
				await server?.close().catch(() => undefined);
				throw error;
			}
		};

		if (opts.port !== 0) return startServer(opts.port);

		try {
			return await startServer(4096);
		} catch (error) {
			if (!isAddressInUseError(error)) throw error;
			return startServer(0);
		}
	}
}

declare module "h3" {
	// noinspection JSUnusedGlobalSymbols
	interface H3EventContext {
		initContext?: Server.CodeWorkInitContext;
	}
}
