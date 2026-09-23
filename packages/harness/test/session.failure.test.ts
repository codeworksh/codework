import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Runner } from "../src/effect.ts";
import { SessionFailure } from "../src/session/failure.ts";
import { Session } from "../src/session/session.ts";

/**
 * The category vocabulary is the public half of a failure: clients branch on
 * `type` without knowing our error classes, so these names are API.
 */
describe("session failure projection", () => {
	it("maps a provider failure to its category and carries the status", () => {
		const failure = SessionFailure.fromCause(
			new Runner.ProviderError({
				provider: "openai",
				model: "gpt-5.5",
				reason: new Runner.ProviderRateLimitError({ message: "too many requests", isRetryable: true, status: 429 }),
			}),
		);

		expect(failure.type).toBe("provider-rate-limit-error");
		expect(failure.status).toBe(429);
		expect(failure.message).toContain("too many requests");
	});

	it("maps non-provider drain failures onto their own categories", () => {
		expect(SessionFailure.fromCause(new Session.SessionNotFoundError({ sessionId: "ses_x" })).type).toBe(
			"session-not-found-error",
		);
		expect(
			SessionFailure.fromCause(new Runner.ModelNotFoundError({ provider: "openai", model: "gpt-5.5" })).type,
		).toBe("model-not-found-error");
	});

	it("degrades unknown causes instead of leaking their shape", () => {
		expect(SessionFailure.fromCause(new Error("boom"))).toEqual({ type: "unknown-error", message: "boom" });
		expect(SessionFailure.fromCause({ weird: true })).toEqual({
			type: "unknown-error",
			message: "Session execution failed",
		});
	});

	it("encodes for the wire", async () => {
		const failure = SessionFailure.fromCause(new Runner.LLMStreamError({ sessionId: "ses_x", reason: "truncated" }));
		expect(Schema.encodeUnknownSync(SessionFailure.Error)(failure)).toEqual({
			type: "llm-stream-error",
			message: "invalid provider event stream: truncated",
		});
	});
});
