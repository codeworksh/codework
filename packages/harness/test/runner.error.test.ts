import { Duration, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Runner } from "../src/effect.ts";

describe("runner error contract", () => {
	it("round-trips provider reasons through their Effect schema", () => {
		const error = new Runner.ProviderError({
			provider: "openrouter",
			model: "stealth/ox-alpha",
			reason: new Runner.ProviderRateLimitError({
				message: "too many requests",
				isRetryable: true,
				status: 429,
				requestId: "req_test",
				retryAfter: Duration.seconds(2),
			}),
		});

		const encoded = Schema.encodeSync(Runner.ProviderError)(error);
		expect(encoded).toMatchObject({
			_tag: "Runner.ProviderError",
			provider: "openrouter",
			model: "stealth/ox-alpha",
			reason: {
				_tag: "Runner.ProviderRateLimitError",
				message: "too many requests",
				isRetryable: true,
				status: 429,
				requestId: "req_test",
			},
		});
		expect(encoded).not.toHaveProperty("cause");

		const decoded = Schema.decodeSync(Runner.ProviderError)(encoded);
		expect(decoded.message).toBe("openrouter/stealth/ox-alpha: too many requests");
		expect(decoded.isRetryable).toBe(true);
		expect(decoded.cause).toBe(decoded.reason);
		expect(Duration.toMillis(decoded.reason.retryAfter!)).toBe(2_000);
	});

	it("gives model lookup failures a useful message", () => {
		const error = new Runner.ModelNotFoundError({ provider: "openrouter", model: "missing" });
		expect(error.message).toContain("openrouter");
		expect(error.message).toContain("missing");
	});
});
