import { createServer, type Server as NodeServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { NamedError } from "@codeworksh/utils";
import { HTTPError } from "h3";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Instance } from "../../src/project/instance.ts";
import { Server } from "../../src/server/server.ts";
import { WorkspaceContext } from "../../src/workspace/context.ts";

vi.mock("../../src/project/project.ts", () => ({
	Project: {
		fromDirectory: vi.fn(async (_directory: string) => ({
			project: {
				id: "global",
				time: {
					created: Date.now(),
					updated: Date.now(),
				},
				vcs: "unknown",
				worktree: "/",
			},
			worktree: "/",
		})),
	},
}));

const servers = new Set<Awaited<ReturnType<typeof Server.listen>>>();
const blockers = new Set<NodeServer>();
const tempDirectories = new Set<string>();
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
	.get("/test/context", async (_event) => {
		await new Promise((resolve) => setTimeout(resolve, 10));
		return {
			directory: Instance.directory,
			project: Instance.project.id,
			workspaceId: WorkspaceContext.workspaceId,
			worktree: Instance.worktree,
		};
	})
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

async function createTempDirectory(name: string) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), `codework-${name}-`));
	tempDirectories.add(directory);
	return directory;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Instance.disposeAll();
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
	await Promise.all(
		[...tempDirectories].map(async (directory) => {
			await fs.rm(directory, { force: true, recursive: true });
			tempDirectories.delete(directory);
		}),
	);
});

describe("Server.App context middleware", () => {
	it("provides request workspace and instance context from headers", async () => {
		const directory = await createTempDirectory("context");
		const server = await Server.listen({ hostname: "127.0.0.1", port: 0 });
		servers.add(server);

		const response = await fetch(new URL("/test/context", server.url), {
			headers: {
				"x-codework-directory": encodeURIComponent(directory),
				"x-codework-workspace": "workspace-a",
			},
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			directory,
			project: "global",
			workspaceId: "workspace-a",
			worktree: "/",
		});
	});

	it("keeps concurrent request contexts isolated by AsyncLocalStorage", async () => {
		const [firstDirectory, secondDirectory] = await Promise.all([
			createTempDirectory("context-a"),
			createTempDirectory("context-b"),
		]);
		const server = await Server.listen({ hostname: "127.0.0.1", port: 0 });
		servers.add(server);

		const [firstResponse, secondResponse] = await Promise.all([
			fetch(new URL("/test/context", server.url), {
				headers: {
					"x-codework-directory": firstDirectory,
					"x-codework-workspace": "workspace-a",
				},
			}),
			fetch(new URL("/test/context", server.url), {
				headers: {
					"x-codework-directory": secondDirectory,
					"x-codework-workspace": "workspace-b",
				},
			}),
		]);

		expect(firstResponse.status).toBe(200);
		expect(secondResponse.status).toBe(200);
		expect(await firstResponse.json()).toMatchObject({
			directory: firstDirectory,
			workspaceId: "workspace-a",
		});
		expect(await secondResponse.json()).toMatchObject({
			directory: secondDirectory,
			workspaceId: "workspace-b",
		});
	});
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
		const body = (await response.json()) as any;

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

describe("Server.App OpenAPI", () => {
	it("serves the OpenAPI document", async () => {
		const response = await Server.App().request("/openapi.json");
		const document = (await response.json()) as any;

		expect(response.status).toBe(200);
		expect(document.openapi).toBe("3.1.0");
		expect(document.info).toMatchObject({
			title: "Codework Agent API",
			version: "0.1.0",
		});
		expect(document.paths["/sessions"].post).toMatchObject({
			operationId: "session.create",
			summary: "Create session",
			responses: {
				201: {
					description: "Successfully created session",
				},
				400: {
					description: "Invalid session create request body",
				},
			},
		});
		expect(document.paths["/sessions"].post.requestBody.content["application/json"].schema).toMatchObject({
			type: "object",
			properties: {
				parentSessionId: { type: "string" },
				name: { type: "string" },
			},
		});
		expect(document.paths["/sessions"].post.responses[201].content["application/json"].schema).toMatchObject({
			type: "object",
			properties: {
				id: { type: "string" },
				name: { type: "string" },
			},
		});
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
