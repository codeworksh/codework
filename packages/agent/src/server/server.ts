import { H3, serve } from "h3";
import { lazy } from "@codeworksh/utils";

export namespace Server {
	const app = new H3();
	type ServerInstance = ReturnType<typeof serve>;
	type ListeningServer = ServerInstance & { url: string };

	export const App: () => H3 = lazy(() => app.get("/", (_event) => "⚡️ Tadaa!"));

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
