import { Cause, Effect } from "effect";
import { describe, expect } from "vite-plus/test";
import { SandboxDriver } from "../src/sandbox/driver.ts";
import { SandboxDriverRegistry } from "../src/sandbox/registry.ts";
import { FakeSandboxDriver } from "../src/sandbox/drivers/fake.ts";
import { makeRedactor, providerError, providerErrorCause } from "../src/sandbox/errors.ts";
import { sanitizeProviderError as sanitizeVercelProviderError } from "../src/sandboxes/vercel/provider.ts";
import { it as effectTests, testEffect } from "./utils/effect.ts";

const fake = FakeSandboxDriver.make();
const { effect: driverIt } = testEffect(SandboxDriverRegistry.layer(fake.driver));
const { effect: it } = effectTests;

describe("SandboxDriver", () => {
	driverIt(
		"round-trips persisted runtime config through unknown JSON",
		Effect.gen(function* () {
			const registry = yield* SandboxDriverRegistry.Registry;
			const name = SandboxDriver.Name.make("fake");
			const runtime = {
				defaultCwd: SandboxDriver.AbsolutePath.make("/workspace"),
				generation: 7,
			};

			const encoded = yield* registry.encodeRuntimeConfig(name, runtime);
			const persisted: unknown = JSON.parse(JSON.stringify(encoded));
			expect(yield* registry.decodeRuntimeConfig(name, persisted)).toEqual(runtime);
		}),
	);
});

describe("Sandbox provider errors", () => {
	it(
		"prefers structured Vercel API details and redacts them",
		Effect.sync(() => {
			const sentinel = "sentinel-super-secret";
			const cause = Object.assign(new Error("Status code 402 is not ok"), {
				json: {
					error: {
						message: `Sandbox quota exhausted token=${sentinel}`,
						code: `quota_${sentinel}`,
					},
				},
			});

			const error = providerError({
				driver: "vercel",
				operation: "create",
				cause,
				redact: makeRedactor([sentinel]),
				sanitize: sanitizeVercelProviderError,
			});

			expect(error.sanitized).toEqual({
				name: "Error",
				message: "Sandbox quota exhausted token=<redacted>",
				code: "quota_<redacted>",
			});
			expect(providerErrorCause(error)).toBe(cause);
		}),
	);

	it(
		"redacts configured and structural secrets without an enumerable raw cause",
		Effect.sync(() => {
			const sentinel = "sentinel-super-secret";
			const cause = new Error(`Authorization: Bearer ${sentinel} https://example.test?a=1&access_token=${sentinel}`);
			const error = providerError({
				driver: "fake",
				operation: "create",
				cause,
				redact: makeRedactor([sentinel]),
			});

			expect(error.sanitized.message).not.toContain(sentinel);
			expect(JSON.stringify(error)).not.toContain(sentinel);
			expect(Cause.pretty(Cause.fail(error))).not.toContain(sentinel);
			expect(Object.keys(error)).not.toContain("cause");
			expect(providerErrorCause(error)).toBe(cause);
		}),
	);
});
