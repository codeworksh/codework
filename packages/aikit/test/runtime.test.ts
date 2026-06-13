import { afterEach, describe, expect, it } from "vite-plus/test";
import { formatThrownError, getEnvApiKey, mergeHeaders } from "../src/llm/runtime";

describe("mergeHeaders", () => {
	it("merges headers with later sources taking precedence", () => {
		expect(mergeHeaders({ a: "1", b: "2" }, { b: "3", c: "4" })).toEqual({ a: "1", b: "3", c: "4" });
	});

	it("skips undefined sources", () => {
		expect(mergeHeaders(undefined, { a: "1" }, undefined)).toEqual({ a: "1" });
	});

	it("preserves null values so callers can unset headers", () => {
		expect(mergeHeaders({ a: "1" }, { a: null })).toEqual({ a: null });
	});

	it("returns an empty object with no sources", () => {
		expect(mergeHeaders()).toEqual({});
	});
});

describe("getEnvApiKey", () => {
	const TEST_KEYS = ["AIKIT_TEST_KEY", "AIKIT_TEST_KEY_PRIMARY", "AIKIT_TEST_KEY_FALLBACK"];

	afterEach(() => {
		for (const name of TEST_KEYS) {
			delete process.env[name];
		}
	});

	it("returns undefined when nothing is configured", () => {
		expect(getEnvApiKey({ env: ["AIKIT_TEST_KEY"] })).toBeUndefined();
	});

	it("reads the key from the provider env list", () => {
		process.env.AIKIT_TEST_KEY = "secret";
		expect(getEnvApiKey({ env: ["AIKIT_TEST_KEY"] })).toBe("secret");
	});

	it("prefers the explicit key name over the env list", () => {
		process.env.AIKIT_TEST_KEY_PRIMARY = "primary";
		process.env.AIKIT_TEST_KEY_FALLBACK = "fallback";
		expect(getEnvApiKey({ key: "AIKIT_TEST_KEY_PRIMARY", env: ["AIKIT_TEST_KEY_FALLBACK"] })).toBe("primary");
	});

	it("falls through empty candidates to the first set variable", () => {
		process.env.AIKIT_TEST_KEY_FALLBACK = "fallback";
		expect(getEnvApiKey({ env: ["AIKIT_TEST_KEY_PRIMARY", "AIKIT_TEST_KEY_FALLBACK"] })).toBe("fallback");
	});
});

describe("formatThrownError", () => {
	it("prefers the stack for Error instances", () => {
		const error = new Error("boom");
		expect(formatThrownError(error)).toBe(error.stack);
	});

	it("falls back to the message when the stack is empty", () => {
		const error = new Error("boom");
		error.stack = "";
		expect(formatThrownError(error)).toBe("boom");
	});

	it("returns strings as-is", () => {
		expect(formatThrownError("plain failure")).toBe("plain failure");
	});

	it("serializes plain objects to JSON", () => {
		expect(formatThrownError({ code: 42 })).toBe('{"code":42}');
	});

	it("stringifies values that cannot be serialized", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(formatThrownError(circular)).toBe("[object Object]");
	});
});
