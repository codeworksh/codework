import { Buffer } from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import { hasLiveOidc } from "./fixtures/vercel";

const token = (payload: unknown): string =>
	`header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.signature`;

describe("Vercel OIDC fixture gate", () => {
	it("accepts a token that remains live beyond the provisioning margin", () => {
		expect(hasLiveOidc(token({ exp: Math.floor(Date.now() / 1000) + 120 }))).toBe(true);
	});

	it("rejects absent, malformed, expired, and nearly expired tokens", () => {
		expect(hasLiveOidc(undefined)).toBe(false);
		expect(hasLiveOidc("not-a-token")).toBe(false);
		expect(hasLiveOidc(token({}))).toBe(false);
		expect(hasLiveOidc(token({ exp: Math.floor(Date.now() / 1000) - 1 }))).toBe(false);
		expect(hasLiveOidc(token({ exp: Math.floor(Date.now() / 1000) + 30 }))).toBe(false);
	});
});
