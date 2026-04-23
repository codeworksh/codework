import { H3, serve } from "h3";
import { lazy } from "@codeworksh/utils";

export namespace Server {
	const app = new H3();
	type ListeningServer = ReturnType<typeof serve> & { url: string };

	export const App: () => H3 = lazy(() => app.get("/", (_event) => "⚡️ Tadaa!"));

	export async function listen(opts: { port: number; hostname: string }): Promise<ListeningServer> {
		const args = {
			hostname: opts.hostname,
			idleTimeout: 0,
			silent: true,
		} as const;

		const tryServe = (port: number) => {
			try {
				return serve(App(), { ...args, port });
			} catch {
				return undefined;
			}
		};
		const server = opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port);
		if (!server) throw new Error(`failed to start server on port: ${opts.port}`);

		await server.ready();
		if (!server.url) throw new Error("failed to resolve server url");

		return server as ListeningServer;
	}
}
