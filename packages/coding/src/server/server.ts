import { H3, serve } from "h3";
import { lazy } from "@codeworksh/utils";

export namespace Server {
  const app = new H3();

  export const App: () => H3 = lazy(() =>
    app.get("/", (_event) => "⚡️ Tadaa!"),
  );

  export async function listen(opts: {
    port: number;
    hostname: string;
  }): Promise<ReturnType<typeof serve>> {
    const args = {
      hostname: opts.hostname,
      idleTimeout: 0,
    } as const;

    const tryServe = (port: number) => {
      try {
        return serve(App(), { ...args, port });
      } catch {
        return undefined;
      }
    };
    const server =
      opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port);
    if (!server)
      throw new Error(`failed to start server on port: ${opts.port}`);

    await server.ready();

    const originalClose = server.close.bind(server);

    server.close = async (closeActiveConnections?: boolean) => {
      try {
      } finally {
        return originalClose(closeActiveConnections);
      }
    };

    return server;
  }
}
