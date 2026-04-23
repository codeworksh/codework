import { createServer, type Server as NodeServer } from "node:http";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Server } from "../src/server/server.ts";

const servers = new Set<Awaited<ReturnType<typeof Server.listen>>>();
const blockers = new Set<NodeServer>();

async function closeNodeServer(server: NodeServer) {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

afterEach(async () => {
	await Promise.all(
		[...servers].map(async (server) => {
			await server.close();
			servers.delete(server);
		}),
	);
	await Promise.all(
		[...blockers].map(async (server) => {
			await closeNodeServer(server);
			blockers.delete(server);
		}),
	);
});

describe("Server.listen", () => {
	it("falls back to an ephemeral port when the preferred port is busy", async () => {
		const blocker = createServer((_req, res) => res.end("busy"));
		await new Promise<void>((resolve) => blocker.listen(4096, "127.0.0.1", resolve));
		blockers.add(blocker);

		const server = await Server.listen({ hostname: "127.0.0.1", port: 0 });
		servers.add(server);

		expect(new URL(server.url).port).not.toBe("4096");
		const response = await fetch(server.url);

		expect(await response.text()).toBe("⚡️ Tadaa!");
	});

	it("preserves the underlying startup error", async () => {
		await expect(Server.listen({ hostname: "not a valid host name", port: 4096 })).rejects.toThrow(
			/getaddrinfo ENOTFOUND not a valid host name/,
		);
	});

	it("disables the node server timeout explicitly", async () => {
		const server = await Server.listen({ hostname: "127.0.0.1", port: 0 });
		servers.add(server);
		const nodeServer = server.node?.server as { timeout?: number } | undefined;

		expect(nodeServer?.timeout).toBe(0);
	});
});
