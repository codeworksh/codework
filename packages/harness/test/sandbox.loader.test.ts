import { Cause, Effect, Exit, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { SandboxDriver } from "../src/sandbox/driver.ts";
import { FakeSandboxDriver } from "../src/sandbox/drivers/fake.ts";
import { SandboxDriverLoadError, SandboxDriverRegistrationError } from "../src/sandbox/errors.ts";
import { SandboxDriverLoader } from "../src/sandbox/loader.ts";
import { SandboxDriverRegistry } from "../src/sandbox/registry.ts";
import { it } from "./utils/effect.ts";

const errorFrom = <A, E>(exit: Exit.Exit<A, E>): E => {
	if (Exit.isSuccess(exit)) throw new Error("expected failure");
	return Cause.squash(exit.cause) as E;
};

const resolver: SandboxDriverLoader.Resolver = (specifier) =>
	Effect.succeed({ specifier, url: "file:///installed/driver.mjs", source: "package" });

const moduleFor = (name = "acme.test") =>
	SandboxDriver.module({
		apiVersion: SandboxDriver.apiVersion,
		name,
		options: Schema.Struct({ token: Schema.optional(Schema.String) }),
		make: () => FakeSandboxDriver.make(SandboxDriver.Name.make(name)).driver,
	});

describe("SandboxDriverLoader", () => {
	it.effect("rejects path references until settings supplies a trusted resolver", () =>
		Effect.gen(function* () {
			for (const specifier of ["./plugin.ts", "../plugin.ts", "/tmp/plugin.ts", "file:///tmp/plugin.ts"]) {
				const exit = yield* Effect.exit(SandboxDriverLoader.packageResolver(process.cwd())(specifier));
				const error = errorFrom(exit);
				expect(error).toBeInstanceOf(SandboxDriverLoadError);
				expect((error as SandboxDriverLoadError).phase).toBe("resolve");
			}
		}),
	);

	it.effect("rejects malformed options without serializing their values", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				SandboxDriverLoader.load(
					{ package: "@acme/codework-sandbox-test", options: { token: 123_456 } },
					{ hostCwd: process.cwd(), resolve: resolver, import: () => Promise.resolve({ default: moduleFor() }) },
				),
			);
			const error = errorFrom(exit);
			expect(error).toBeInstanceOf(SandboxDriverLoadError);
			expect((error as SandboxDriverLoadError).phase).toBe("options");
			expect(JSON.stringify(error)).not.toContain("123456");
		}),
	);

	it.effect("rejects unsupported module API versions before running the factory", () => {
		let called = false;
		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				SandboxDriverLoader.load("@acme/codework-sandbox-test", {
					hostCwd: process.cwd(),
					resolve: resolver,
					import: () =>
						Promise.resolve({
							default: { ...moduleFor(), apiVersion: 2, make: () => ((called = true), moduleFor().make({})) },
						}),
				}),
			);
			const error = errorFrom(exit);
			expect(error).toBeInstanceOf(SandboxDriverLoadError);
			expect((error as SandboxDriverLoadError).phase).toBe("api-version");
			expect(called).toBe(false);
		});
	});

	it.effect("rejects reserved provider names from third-party packages", () =>
		Effect.gen(function* () {
			const registration = SandboxDriver.withSource(
				FakeSandboxDriver.make(SandboxDriver.Name.make("vercel")).driver,
				"package",
			);
			const exit = yield* Effect.exit(SandboxDriverRegistry.make([registration]));
			expect(errorFrom(exit)).toBeInstanceOf(SandboxDriverRegistrationError);
		}),
	);
});
