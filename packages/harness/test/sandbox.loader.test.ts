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
	it.effect("loads a package module, decodes options, and records its source", () =>
		Effect.gen(function* () {
			const loaded = yield* SandboxDriverLoader.load(
				{ package: "@acme/codework-sandbox-test", options: { token: "secret" } },
				{ resolve: resolver, import: () => Promise.resolve({ default: moduleFor() }) },
			);
			expect(loaded.registered.name).toBe("acme.test");
			expect(loaded.source).toBe("package");
		}),
	);

	it.effect("rejects path references until settings supplies a trusted resolver", () =>
		Effect.gen(function* () {
			for (const specifier of ["./plugin.ts", "../plugin.ts", "/tmp/plugin.ts", "file:///tmp/plugin.ts"]) {
				const exit = yield* Effect.exit(SandboxDriverLoader.packageResolver()(specifier));
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
					{ resolve: resolver, import: () => Promise.resolve({ default: moduleFor() }) },
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

	it.effect("resolves installed package subpaths to canonical file URLs", () =>
		Effect.gen(function* () {
			const resolved = yield* SandboxDriverLoader.packageResolver()("effect/Schema");
			expect(resolved.url).toMatch(/^file:/);
			expect(resolved.url).toContain("/effect/dist/Schema.js");
		}),
	);

	it.effect("loads the installed external Vercel copy by package name", () =>
		Effect.gen(function* () {
			const loaded = yield* SandboxDriverLoader.load("@codeworksh-test/codework-sandbox-vercel", {
				resolve: SandboxDriverLoader.packageResolver(process.cwd(), ["development", "node", "import", "default"]),
			});
			const registry = yield* SandboxDriverRegistry.make([loaded]);
			expect(registry.drivers).toMatchObject([
				{
					name: "codework.test.vercel",
					source: "package",
					kind: "remote",
					capabilities: { inspect: true, reattach: true, wake: true, stop: true, destroy: true },
				},
			]);
		}),
	);

	it.effect("loads a first-party provider through its public package subpath", () =>
		Effect.gen(function* () {
			const loaded = yield* SandboxDriverLoader.load("@codeworksh/harness/sandboxes/vercel", {
				resolve: SandboxDriverLoader.packageResolver(process.cwd(), ["development", "node", "import", "default"]),
			});
			expect(loaded.registered.name).toBe("vercel");
			expect(loaded.source).toBe("builtin");
		}),
	);

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
