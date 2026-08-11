import { Cause, Effect, Exit, Option, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { SandboxDriver } from "../src/sandbox/driver.ts";
import { FakeSandboxDriver } from "../src/sandbox/drivers/fake.ts";
import {
	makeRedactor,
	providerError,
	providerErrorCause,
	SandboxDriverNotRegisteredError,
	SandboxDriverRegistrationError,
} from "../src/sandbox/errors.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import { it as effectTests, testEffect } from "./utils/effect.ts";

const fake = FakeSandboxDriver.make();
const { effect: driverIt } = testEffect(SandboxDriver.layer(fake.driver));
const { effect: it } = effectTests;

describe("SandboxDriver", () => {
	driverIt(
		"registers an open driver name and rejects unknown names",
		Effect.gen(function* () {
			const registry = yield* SandboxDriver.Registry;
			expect(registry.names).toEqual(new Set([SandboxDriver.Name.make("fake")]));
			expect(Option.isSome(registry.find(SandboxDriver.Name.make("fake")))).toBe(true);

			const result = yield* Effect.exit(registry.get(SandboxDriver.Name.make("cloudflare")));
			expect(Exit.isFailure(result)).toBe(true);
			if (Exit.isFailure(result)) {
				expect(Cause.squash(result.cause)).toBeInstanceOf(SandboxDriverNotRegisteredError);
			}
		}),
	);

	driverIt(
		"uses the registered codecs as the authoritative unknown boundary",
		Effect.gen(function* () {
			const registry = yield* SandboxDriver.Registry;
			const name = SandboxDriver.Name.make("fake");

			const create = yield* registry.decodeCreateConfig(name, { defaultCwd: "/workspace" });
			expect(create).toEqual({ defaultCwd: "/workspace" });

			const runtime = yield* registry.decodeRuntimeConfig(name, {
				defaultCwd: "/workspace",
				generation: 1,
			});
			expect(runtime.defaultCwd).toBe("/workspace");

			const relative = yield* Effect.exit(
				registry.decodeRuntimeConfig(name, { defaultCwd: "workspace", generation: 1 }),
			);
			expect(Exit.isFailure(relative)).toBe(true);
			if (Exit.isFailure(relative)) {
				expect(Cause.squash(relative.cause)).toBeInstanceOf(SandboxDriverRegistrationError);
			}
		}),
	);

	driverIt(
		"round-trips persisted runtime config through unknown JSON",
		Effect.gen(function* () {
			const registry = yield* SandboxDriver.Registry;
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

	it(
		"rejects duplicate names and destroy without stop",
		Effect.gen(function* () {
			const duplicate = yield* Effect.exit(SandboxDriver.makeRegistry([fake.driver, fake.driver]));
			expect(Exit.isFailure(duplicate)).toBe(true);
			if (Exit.isFailure(duplicate)) {
				expect(Cause.squash(duplicate.cause)).toBeInstanceOf(SandboxDriverRegistrationError);
			}

			const invalid = SandboxDriver.driver({
				...fake.driver,
				name: SandboxDriver.Name.make("invalid"),
				capabilities: { ...fake.driver.capabilities, stop: false, destroy: true },
			});
			const capability = yield* Effect.exit(SandboxDriver.makeRegistry([invalid]));
			expect(Exit.isFailure(capability)).toBe(true);
			if (Exit.isFailure(capability)) {
				expect(Cause.squash(capability.cause)).toBeInstanceOf(SandboxDriverRegistrationError);
			}
		}),
	);

	it(
		"adds an arbitrary Cloudflare-shaped driver without changing the registry",
		Effect.gen(function* () {
			const cloudflare = SandboxDriver.driver({
				...fake.driver,
				name: SandboxDriver.Name.make("cloudflare-workers"),
			});
			const registry = yield* SandboxDriver.makeRegistry([fake.driver, cloudflare]);
			expect(registry.names).toEqual(
				new Set([SandboxDriver.Name.make("fake"), SandboxDriver.Name.make("cloudflare-workers")]),
			);
		}),
	);

	it(
		"keeps the fake namespace alive across detach and reattach",
		Effect.gen(function* () {
			const owned = FakeSandboxDriver.make(SandboxDriver.Name.make("fake-remount"));
			const instanceId = SandboxInstance.ID.make("sbx_fake_remount");
			const provisioned = yield* owned.driver.create({
				instanceId,
				config: { defaultCwd: SandboxDriver.AbsolutePath.make("/workspace") },
			});
			const input = {
				id: instanceId,
				providerResourceId: Option.fromUndefinedOr(provisioned.providerResourceId),
				runtimeConfig: provisioned.runtimeConfig,
			};

			yield* Effect.gen(function* () {
				const fs = yield* SandboxIO.FileSystem;
				const shell = yield* SandboxIO.Shell;
				yield* fs.writeFile("/workspace/marker.txt", "kept");
				expect((yield* shell.exec("cat marker.txt", { cwd: "/workspace" })).stdout).toBe("kept");
			}).pipe(Effect.provide(owned.driver.attach(input)), Effect.scoped);

			const marker = yield* Effect.flatMap(SandboxIO.FileSystem, (fs) => fs.readFile("/workspace/marker.txt")).pipe(
				Effect.provide(owned.driver.attach(input)),
				Effect.scoped,
			);
			expect(marker).toBe("kept");
			expect(owned.state.calls.attach).toEqual([instanceId, instanceId]);
		}),
	);

	it(
		"rejects relative defaults directly in the base codec",
		Effect.gen(function* () {
			expect(
				Exit.isFailure(
					yield* Effect.exit(
						Schema.decodeUnknownEffect(SandboxDriver.RuntimeConfigBase)({ defaultCwd: "relative" }),
					),
				),
			).toBe(true);
		}),
	);
});

describe("Sandbox provider errors", () => {
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
