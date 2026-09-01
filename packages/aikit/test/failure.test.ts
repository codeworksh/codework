import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import { describe, expect, it } from "vite-plus/test";
import { Failure } from "../src/index.ts";

describe("provider failure normalization", () => {
	it("classifies a missing API key as authentication", () => {
		const failure = Failure.normalize(new LoadAPIKeyError({ message: "OpenRouter API key is missing" }));

		expect(failure).toEqual({
			_tag: "Authentication",
			reason: "missing",
			message: "openrouter API key is missing",
			retryable: false,
		});
	});

	it("keeps safe rate-limit metadata and drops provider payloads", () => {
		const failure = Failure.normalize(
			new APICallError({
				message: "Too many requests",
				url: "https://provider.invalid/v1/chat",
				requestBodyValues: { secret: "request body" },
				statusCode: 429,
				responseHeaders: { "retry-after": "2", "x-request-id": "req_test" },
				responseBody: "sensitive response body",
			}),
		);

		expect(failure).toEqual({
			_tag: "RateLimit",
			message: "too many requests",
			retryable: true,
			status: 429,
			requestId: "req_test",
			retryAfterMs: 2_000,
		});
		expect(JSON.stringify(failure)).not.toContain("sensitive");
	});

	it("distinguishes quota exhaustion from ordinary rate limiting", () => {
		const failure = Failure.normalize(
			new APICallError({
				message: "Insufficient quota",
				url: "https://provider.invalid/v1/chat",
				requestBodyValues: {},
				statusCode: 429,
				data: { error: { code: "insufficient_quota" } },
			}),
		);

		expect(failure._tag).toBe("Quota");
		expect(failure.code).toBe("insufficient_quota");
	});

	it("recognizes Codex policy codes and OpenAI request ids", () => {
		const failure = Failure.normalize(
			new APICallError({
				message: "Request blocked",
				url: "https://chatgpt.com/backend-api/codex/responses",
				requestBodyValues: {},
				statusCode: 400,
				responseHeaders: { "x-oai-request-id": "req_codex" },
				data: { error: { code: "cyber_policy" } },
			}),
		);

		expect(failure).toMatchObject({
			_tag: "ContentPolicy",
			code: "cyber_policy",
			requestId: "req_codex",
		});
	});
});
