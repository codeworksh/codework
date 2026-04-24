import { createServer, type Server as NodeServer } from "node:http";
import { Type } from "@sinclair/typebox";
import { NamedError } from "@codeworksh/utils";
import { HTTPError } from "h3";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Server } from "../src/server/server.ts";

const servers = new Set<Awaited<ReturnType<typeof Server.listen>>>();
const blockers = new Set<NodeServer>();
const TestError = NamedError.create(
	"TestError",
	Type.Object({
		message: Type.String(),
	}),
);
let namedRouteError: InstanceType<typeof TestError>;
let unknownRouteError: Error;
let httpRouteError: HTTPError;

Server.App()
	.get("/test/named-error", () => {
		throw namedRouteError;
	})
	.get("/test/unknown-error", () => {
		throw unknownRouteError;
	})
	.get("/test/http-error", () => {
		throw httpRouteError;
	});

async function closeNodeServer(server: NodeServer) {
	await new Promise<void>((resolve, reject) => {
		server.close((error: any) => (error ? reject(error) : resolve()));
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
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

describe("Server.App error handling", () => {
	it("serializes named errors and logs the original error", async () => {
		const error = new TestError({ message: "named failure" });
		namedRouteError = error;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const server = await Server.listen({ hostname: "127.0.0.1", port: 0 });
		servers.add(server);

		const response = await fetch(new URL("/test/named-error", server.url));

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			name: "TestError",
			data: { message: "named failure" },
		});
		expect(errorSpy).toHaveBeenCalledWith(error);
	});

	it("wraps unknown errors as UnknownError responses", async () => {
		const error = new Error("unknown failure");
		unknownRouteError = error;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const server = await Server.listen({ hostname: "127.0.0.1", port: 0 });
		servers.add(server);

		const response = await fetch(new URL("/test/unknown-error", server.url));
		const body = await response.json();

		expect(response.status).toBe(500);
		expect(body.name).toBe("UnknownError");
		expect(body.data.message).toContain("unknown failure");
		expect(errorSpy).toHaveBeenCalledWith(error);
	});

	it("preserves explicit H3 HTTP errors", async () => {
		const error = HTTPError.status(404, "Not Found", { message: "missing route" });
		httpRouteError = error;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const server = await Server.listen({ hostname: "127.0.0.1", port: 0 });
		servers.add(server);

		const response = await fetch(new URL("/test/http-error", server.url));

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			status: 404,
			statusText: "Not Found",
			message: "missing route",
		});
		expect(errorSpy).toHaveBeenCalledWith(error);
	});
});

describe("Server.listen", () => {
	it("falls back to an ephemeral port when the preferred port is busy", async () => {
		const blocker = createServer((_req: any, res: any) => res.end("busy"));
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
