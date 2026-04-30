import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const createSessionSchema = Type.Optional(
	Type.Object({
		parentSessionId: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
	}),
);
const createSession = Object.assign(vi.fn(), {
	schema: createSessionSchema,
});
const getSession = Object.assign(vi.fn(), {
	schema: Type.String(),
});

vi.mock("../../src/session/session.ts", () => ({
	Session: {
		create: createSession,
		get: getSession,
	},
}));

const { SessionRoutes } = await import("../../src/server/routes/session.ts");

describe("SessionRoutes", () => {
	beforeEach(() => {
		createSession.mockReset();
		getSession.mockReset();
	});

	it("creates a session from an optional JSON body", async () => {
		const session = { id: "session-1", name: "Test session" };
		createSession.mockResolvedValueOnce(session);

		const response = await SessionRoutes().request("/", {
			body: JSON.stringify({ name: "Test session" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(201);
		expect(createSession).toHaveBeenCalledWith({ name: "Test session" });
		expect(await response.json()).toEqual(session);
	});

	it("creates a session without a request body", async () => {
		const session = { id: "session-2", name: "New session" };
		createSession.mockResolvedValueOnce(session);

		const response = await SessionRoutes().request("/", {
			method: "POST",
		});

		expect(response.status).toBe(201);
		expect(createSession).toHaveBeenCalledWith(undefined);
		expect(await response.json()).toEqual(session);
	});

	it("rejects invalid create input", async () => {
		const response = await SessionRoutes().request("/", {
			body: JSON.stringify({ name: 123 }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
		expect(createSession).not.toHaveBeenCalled();
	});

	it("gets a session by route parameter", async () => {
		const session = { id: "session-3", name: "Existing session" };
		getSession.mockResolvedValueOnce(session);

		const response = await SessionRoutes().request("/session-3", {
			method: "GET",
		});

		expect(response.status).toBe(200);
		expect(getSession).toHaveBeenCalledWith("session-3");
		expect(await response.json()).toEqual(session);
	});
});
