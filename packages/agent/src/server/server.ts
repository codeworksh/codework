import { H3, type H3Event, type HTTPError, onError, serve } from "h3";
import { lazy, NamedError, Filesystem, iife } from "@codeworksh/utils";
import { type Sandbox } from "../sandbox/sandbox.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { Instance } from "../project/instance.ts";
import { InstanceBootstrap } from "../project/bootstrap.ts";
import { namedErrorResponse } from "./error.ts";
import { OpenAPI } from "./openapi.ts";
import { SessionRoutes } from "./routes/session.ts";
import { createLocalEnv, createInMemoryEphemeralEnv } from "../sandbox/builtin.ts";

export namespace Server {
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
								return await createLocalEnv(directory);
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
							key: sandbox.id,
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
