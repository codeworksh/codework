import { H3, type HTTPError, onError, serve } from "h3";
import { lazy, NamedError, Filesystem } from "@codeworksh/utils";
import { WorkspaceContext } from "../workspace/context.ts";
import { Instance } from "../project/instance.ts";
import { InstanceBootstrap } from "../project/bootstrap.ts";
import { SessionRoutes } from "./routes/session.ts";

export namespace Server {
	const app = new H3();
	type ServerInstance = ReturnType<typeof serve>;
	type ListeningServer = ServerInstance & { url: string };

	function getErrorCause(error: HTTPError) {
		return error.cause instanceof Error ? error.cause : error;
	}

	function getErrorMessage(error: unknown) {
		if (error instanceof Error) return error.stack || error.message;
		return String(error);
	}

	function getErrorResponse(error: HTTPError) {
		const cause = getErrorCause(error);
		console.error(cause);

		if (cause instanceof NamedError) {
			return Response.json(cause.toObject(), { status: 500 });
		}

		if (!error.unhandled) {
			return Response.json(error.toJSON(), {
				headers: error.headers,
				status: error.status,
			});
		}

		return Response.json(new NamedError.Unknown({ message: getErrorMessage(cause) }).toObject(), { status: 500 });
	}

	export const App: () => H3 = lazy(() =>
		app
			.use(onError(getErrorResponse))
			.use(async (event, next) => {
				const workspaceId = event.req.headers.get("x-codework-workspace") || "local";
				const raw = event.req.headers.get("x-codework-directory") || process.cwd();

				const directory = Filesystem.resolve(
					(() => {
						try {
							return decodeURIComponent(raw);
						} catch {
							return raw;
						}
					})(),
				);

				return WorkspaceContext.provide({
					workspaceId,
					async fn() {
						return Instance.provide({
							directory,
							init: InstanceBootstrap,
							async fn() {
								return next();
							},
						});
					},
				});
			})
			.mount("/sessions", SessionRoutes())
			.get("/", (_event) => "⚡️ Tadaa!"),
	);

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
