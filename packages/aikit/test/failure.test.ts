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

	it("reads retry-after-ms and an HTTP-date retry-after", () => {
		const retryAfter = (responseHeaders: Record<string, string>) =>
			Failure.normalize(
				new APICallError({
					message: "Overloaded",
					url: "https://provider.invalid/v1/chat",
					requestBodyValues: {},
					statusCode: 529,
					responseHeaders,
				}),
			).retryAfterMs;

		expect(retryAfter({ "retry-after-ms": "1500", "retry-after": "9" })).toBe(1_500);
		const at = retryAfter({ "retry-after": new Date(Date.now() + 45_000).toUTCString() });
		expect(at).toBeGreaterThan(43_000);
		expect(at).toBeLessThanOrEqual(45_000);
		expect(retryAfter({ "retry-after": "Thu, 01 Jan 1970 00:00:00 GMT" })).toBe(0);
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

	const limited = (data: unknown, message = "Too many requests") =>
		Failure.normalize(
			new APICallError({
				message,
				url: "https://provider.invalid/v1/chat",
				requestBodyValues: {},
				statusCode: 429,
				responseHeaders: { "retry-after": "2" },
				data,
			}),
		);

	it.each([
		["Codex subscription usage limit", { error: { code: "subscription_sharing_usage_limit_exceeded" } }],
		["OpenCode Go usage limit", { type: "GoUsageLimitError", message: "Usage limit exceeded" }],
		["OpenCode free-tier usage limit", { type: "FreeUsageLimitError" }],
		["monthly usage prose", { error: { message: "Monthly usage limit reached. Enable available balance usage." } }],
		["generic usage limit prose", { error: { message: "You have hit your usage limit for this period" } }],
		["budget prose", { error: { message: "Organization is out of budget" } }],
		["monthly quota prose", { error: { message: "Monthly quota exceeded" } }],
	])("classifies a %s 429 as quota, not rate limiting", (_name, data) => {
		expect(limited(data)._tag).toBe("Quota");
	});

	it.each([
		["a rate-limit code", { error: { code: "rate_limit_exceeded", message: "Rate limit reached" } }],
		[
			"a rate-limit code with quota prose",
			{ error: { code: "rate_limit_exceeded", message: "Usage limit: slow down" } },
		],
		["a per-minute quota", { error: { message: "Quota exceeded for quota metric 'Requests per minute'" } }],
		["a per-minute usage limit", { error: { message: "Usage limit of 60 requests per minute exceeded" } }],
		["a rate-limit code naming a quota", { error: { code: "rate_limit_quota_exceeded" } }],
		["a bare 429", undefined],
	])("keeps %s as a retryable rate limit", (_name, data) => {
		expect(limited(data)).toMatchObject({ _tag: "RateLimit", retryable: true, retryAfterMs: 2_000 });
	});

	it("classifies an exhausted credit balance as quota, whatever the status", () => {
		const failure = Failure.normalize(
			new APICallError({
				message: "Your credit balance is too low",
				url: "https://api.anthropic.com/v1/messages",
				requestBodyValues: {},
				statusCode: 400,
				data: { error: { type: "invalid_request_error", message: "Your credit balance is too low" } },
			}),
		);
		expect(failure).toMatchObject({ _tag: "Quota", retryable: false, status: 400 });
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
