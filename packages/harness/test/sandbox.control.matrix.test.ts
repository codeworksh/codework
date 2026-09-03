import { Cause, Effect, Exit, Layer, Option } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { SandboxController } from "../src/sandbox/control.ts";
import { SandboxDriver } from "../src/sandbox/driver.ts";
import { SandboxDriverRegistry } from "../src/sandbox/registry.ts";
import { FakeSandboxDriver } from "../src/sandbox/drivers/fake.ts";
import {
	SandboxBusyError,
	SandboxDriverRegistrationError,
	SandboxNotFoundError,
	SandboxUnavailError,
	SandboxUnsupportedError,
} from "../src/sandbox/errors.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import { SandboxStore } from "../src/sandbox/store.ts";
import { testEffect } from "./utils/effect.ts";

/**
 * Control-plane matrix gaps: operations and edges the main controller suite
 * does not pin — `withMount`, non-mountable statuses, fault recovery by mount,
 * mount-time not-found, stop guards, live-reference wake, registration
 * conflicts, capability/implementation mismatches, host lifecycle refusals,
 * usage filtering, shutdown without deletion, and transport idle eviction.
 */

const fake = FakeSandboxDriver.make(SandboxDriver.Name.make("matrix-fake"));
const dependencies = Layer.merge(Database.layer(":memory:"), SandboxDriverRegistry.layer(fake.driver));
const controllerLayer = Layer.provideMerge(
	SandboxController.layer({ transportIdleTimeToLive: "1 hour" }),
	dependencies,
);
const { effect: it } = testEffect(controllerLayer);

const create = (controller: SandboxController.Controller["Service"], defaultCwd = "/workspace") =>
	controller.create({
		driver: fake.driver,
		config: { defaultCwd: SandboxDriver.AbsolutePath.make(defaultCwd) },
	});

const failure = <E>(exit: Exit.Exit<unknown, E>): E => {
	if (Exit.isSuccess(exit)) throw new Error("expected failure");
	return Cause.squash(exit.cause) as E;
};

const mountExit = (controller: SandboxController.Controller["Service"], id: SandboxInstance.ID) =>
	Effect.flatMap(SandboxIO.Current, Effect.succeed).pipe(
		Effect.provide(controller.mount(id)),
		Effect.scoped,
		Effect.exit,
	);

describe("Sandbox.Controller matrix", () => {
	it(
		"withMount provides the mount, holds one lease, and releases it after use",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const info = yield* create(controller);

			const observed = yield* controller.withMount(
				info.id,
				Effect.gen(function* () {
					const current = yield* SandboxIO.Current;
					const fs = yield* SandboxIO.FileSystem;
					yield* fs.writeFile("probe.txt", "via withMount");
					return {
						current,
						usage: Option.getOrThrow(yield* controller.get(info.id)).usage,
					};
				}),
			);

			expect(observed.current.id).toBe(info.id);
			expect(observed.current.cwd).toBe("/workspace");
			expect(observed.usage).toBe("busy");
			expect(Option.getOrThrow(yield* controller.get(info.id)).usage).toBe("idle");

			// the write really landed in the namespace, resolved against mount cwd
			const persisted = yield* controller.withMount(
				info.id,
				Effect.flatMap(SandboxIO.FileSystem, (fs) => fs.readFile("/workspace/probe.txt")),
			);
			expect(persisted).toBe("via withMount");
		}),
	);

	it(
		"withMount surfaces the typed mount error for an unknown instance",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const exit = yield* Effect.exit(controller.withMount(SandboxInstance.ID.create(), Effect.void));
			expect(failure(exit)).toBeInstanceOf(SandboxNotFoundError);
		}),
	);

	it(
		"resolves a relative mount cwd against the driver's default cwd",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const info = yield* create(controller);

			const current = yield* Effect.flatMap(SandboxIO.Current, Effect.succeed).pipe(
				Effect.provide(controller.mount(info.id, { cwd: "nested" })),
				Effect.scoped,
			);
			expect(current.cwd).toBe("/workspace/nested");
		}),
	);

	it(
		"refuses to mount while suspending, removing, or provisioning",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const store = yield* SandboxStore.make;
			const info = yield* create(controller);

			yield* store.transition({ id: info.id, from: ["online"], to: "suspending" });
			expect(failure(yield* mountExit(controller, info.id))).toBeInstanceOf(SandboxUnavailError);

			yield* store.transition({ id: info.id, from: ["suspending"], to: "removing" });
			expect(failure(yield* mountExit(controller, info.id))).toBeInstanceOf(SandboxUnavailError);

			yield* store.transition({ id: info.id, from: ["removing"], to: "provisioning" });
			expect(failure(yield* mountExit(controller, info.id))).toBeInstanceOf(SandboxUnavailError);
		}),
	);

	it(
		"mounts a faulted instance and clears the fault on successful attachment",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const store = yield* SandboxStore.make;
			const info = yield* create(controller);
			yield* store.transition({ id: info.id, from: ["online"], to: "faulted" });

			const current = yield* Effect.flatMap(SandboxIO.Current, Effect.succeed).pipe(
				Effect.provide(controller.mount(info.id)),
				Effect.scoped,
			);
			expect(current.id).toBe(info.id);

			const recovered = Option.getOrThrow(yield* controller.get(info.id));
			expect(recovered.status).toBe("online");
			expect(Option.isNone(recovered.lastError)).toBe(true);
		}),
	);

	it(
		"records a mount-time missing resource as unavail without recreating it",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const info = yield* create(controller);
			fake.state.remove(info.id);
			const createCalls = fake.state.calls.create.length;

			expect(failure(yield* mountExit(controller, info.id))).toBeInstanceOf(SandboxUnavailError);
			expect(Option.getOrThrow(yield* controller.get(info.id)).status).toBe("unavail");

			// a second attempt is refused from the row alone: no driver retry, no new resource
			expect(failure(yield* mountExit(controller, info.id))).toBeInstanceOf(SandboxUnavailError);
			expect(fake.state.calls.create).toHaveLength(createCalls);
		}),
	);

	it(
		"refuses to stop a mounted instance and short-circuits an already stopped one",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const info = yield* create(controller);

			yield* Effect.gen(function* () {
				expect(failure(yield* Effect.exit(controller.stop(info.id)))).toBeInstanceOf(SandboxBusyError);
			}).pipe(Effect.provide(controller.mount(info.id)), Effect.scoped);

			expect((yield* controller.stop(info.id)).status).toBe("offline");
			const stopCalls = fake.state.calls.stop.length;
			// stopping an offline instance returns the row without another driver call
			expect((yield* controller.stop(info.id)).status).toBe("offline");
			expect(fake.state.calls.stop).toHaveLength(stopCalls);
		}),
	);

	it(
		"keeps a referenced transport attached across wake",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const info = yield* create(controller, "/");
			const before = fake.state.calls.attach.length;

			yield* Effect.gen(function* () {
				const fs = yield* SandboxIO.FileSystem;
				yield* fs.writeFile("/before-wake.txt", "held");
				yield* controller.wake(info.id);
				// the live mount keeps working over the same shared transport
				expect(yield* fs.readFile("/before-wake.txt")).toBe("held");
				yield* Effect.flatMap(SandboxIO.FileSystem, (nested) => nested.exists("/before-wake.txt")).pipe(
					Effect.provide(controller.mount(info.id)),
					Effect.scoped,
				);
			}).pipe(Effect.provide(controller.mount(info.id)), Effect.scoped);

			// wake with a live reference must not invalidate: one attach in total
			expect(fake.state.calls.attach.length - before).toBe(1);
		}),
	);

	it(
		"rejects registering a locator already owned by a managed instance",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const info = yield* create(controller);
			const locator = Option.getOrThrow(info.providerResourceId);

			const exit = yield* Effect.exit(controller.register({ driver: fake.driver, providerResourceId: locator }));
			expect(failure(exit)).toBeInstanceOf(SandboxDriverRegistrationError);
		}),
	);

	it(
		"rejects re-registering an external resource under a different runtime config",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const provisioned = yield* fake.driver.create({
				instanceId: SandboxInstance.ID.create(),
				config: { defaultCwd: SandboxDriver.AbsolutePath.make("/external") },
			});
			const locator = provisioned.providerResourceId!;

			const first = yield* controller.register({ driver: fake.driver, providerResourceId: locator });
			expect(first.ownership).toBe("external");

			const conflicting = yield* Effect.exit(
				controller.register({
					driver: fake.driver,
					providerResourceId: locator,
					runtimeConfig: { generation: 9999 },
				}),
			);
			expect(failure(conflicting)).toBeInstanceOf(SandboxDriverRegistrationError);

			// external ownership blocks stop as well as destroy
			expect(failure(yield* Effect.exit(controller.stop(first.id)))).toBeInstanceOf(SandboxUnsupportedError);
		}),
	);

	it(
		"releases the reserved reference when createAndMount fails to provision",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const instanceId = SandboxInstance.ID.create();
			fake.state.failNext("create", new Error("quota exceeded"));

			const exit = yield* Layer.build(
				controller.createAndMount({
					driver: fake.driver,
					config: { defaultCwd: SandboxDriver.AbsolutePath.make("/workspace") },
					instanceId,
				}),
			).pipe(Effect.scoped, Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);

			const info = Option.getOrThrow(yield* controller.get(instanceId));
			expect(info.status).toBe("faulted");
			expect(info.refCount).toBe(0);
			expect(info.usage).toBe("idle");
		}),
	);

	it(
		"controller shutdown releases transports without deleting driver resources",
		Effect.gen(function* () {
			const ambient = yield* SandboxController.Controller;
			const destroyCalls = fake.state.calls.destroy.length;

			const instanceId = yield* Effect.scoped(
				Effect.gen(function* () {
					const controller = yield* SandboxController.make({ transportIdleTimeToLive: "1 hour" });
					const info = yield* create(controller);
					yield* Effect.flatMap(SandboxIO.FileSystem, (fs) =>
						fs.writeFile("/workspace/survivor.txt", "kept"),
					).pipe(Effect.provide(controller.mount(info.id)), Effect.scoped);
					return info.id;
				}),
			);

			// the scope closed the second control plane: no deletion happened
			expect(fake.state.calls.destroy).toHaveLength(destroyCalls);
			expect(fake.state.resources.has(instanceId)).toBe(true);

			// the shared row lets another control plane reattach to the same namespace
			const content = yield* Effect.flatMap(SandboxIO.FileSystem, (fs) =>
				fs.readFile("/workspace/survivor.txt"),
			).pipe(Effect.provide(ambient.mount(instanceId)), Effect.scoped);
			expect(content).toBe("kept");
		}),
	);

	it(
		"reports refresh as unsupported when the driver has no inspect",
		Effect.gen(function* () {
			const bare = FakeSandboxDriver.make(SandboxDriver.Name.make("matrix-no-inspect"));
			const { registered: _registered, inspect: _inspect, ...rest } = bare.driver;
			const noInspect = SandboxDriver.driver({
				...rest,
				capabilities: { ...rest.capabilities, inspect: false },
			});

			const controller = yield* SandboxController.make({ transportIdleTimeToLive: "1 hour" }).pipe(
				Effect.provide(SandboxDriverRegistry.layer(noInspect)),
			);
			const info = yield* controller.create({
				driver: noInspect,
				config: { defaultCwd: SandboxDriver.AbsolutePath.make("/workspace") },
			});

			expect(failure(yield* Effect.exit(controller.refresh(info.id)))).toBeInstanceOf(SandboxUnsupportedError);
		}),
	);

	it(
		"treats the host as pinned: wake is identity, stop and refresh are unsupported",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;

			const woken = yield* controller.wake(SandboxInstance.ID.local);
			expect(woken.usage).toBe("pinned");
			expect(woken.status).toBe("online");

			expect(failure(yield* Effect.exit(controller.stop(SandboxInstance.ID.local)))).toBeInstanceOf(
				SandboxUnsupportedError,
			);
			expect(failure(yield* Effect.exit(controller.refresh(SandboxInstance.ID.local)))).toBeInstanceOf(
				SandboxUnsupportedError,
			);
		}),
	);

	it(
		"filters list by usage and answers unknown ids with none",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const info = yield* create(controller);

			yield* Effect.gen(function* () {
				const busy = yield* controller.list({ usage: "busy" });
				expect(busy.map((entry) => entry.id)).toEqual([info.id]);
				const idle = yield* controller.list({ usage: "idle" });
				expect(idle.some((entry) => entry.id === info.id)).toBe(false);
			}).pipe(Effect.provide(controller.mount(info.id)), Effect.scoped);

			const pinned = yield* controller.list({ usage: "pinned" });
			expect(pinned.map((entry) => entry.id)).toEqual([SandboxInstance.ID.local]);

			expect(Option.isNone(yield* controller.get(SandboxInstance.ID.create()))).toBe(true);
		}),
	);

	it(
		"evicts an idle transport after its time-to-live and reattaches on the next mount",
		Effect.gen(function* () {
			const controller = yield* SandboxController.make({ transportIdleTimeToLive: "5 seconds" });
			const info = yield* create(controller);
			const before = fake.state.calls.attach.length;

			const probe = Effect.flatMap(SandboxIO.FileSystem, (fs) => fs.exists("/workspace")).pipe(
				Effect.provide(controller.mount(info.id)),
				Effect.scoped,
			);

			yield* probe;
			expect(fake.state.calls.attach.length - before).toBe(1);

			// still cached inside the TTL window
			yield* TestClock.adjust("1 second");
			yield* probe;
			expect(fake.state.calls.attach.length - before).toBe(1);

			// idle past the TTL: the cached transport is released
			yield* TestClock.adjust("30 seconds");
			yield* probe;
			expect(fake.state.calls.attach.length - before).toBe(2);
		}),
	);
});

describe("SandboxDriver registry capability validation", () => {
	const base = FakeSandboxDriver.make(SandboxDriver.Name.make("matrix-caps"));

	it(
		"rejects a declared capability with no implementation",
		Effect.gen(function* () {
			const { registered: _registered, wake: _wake, ...rest } = base.driver;
			const missingWake = SandboxDriver.driver(rest);

			const exit = yield* Effect.exit(SandboxDriverRegistry.make([missingWake]));
			const error = failure(exit);
			expect(error).toBeInstanceOf(SandboxDriverRegistrationError);
			expect((error as SandboxDriverRegistrationError).reason).toContain("wake");
		}),
	);

	it(
		"rejects an implemented operation whose capability is undeclared",
		Effect.gen(function* () {
			const { registered: _registered, ...rest } = base.driver;
			const undeclaredWake = SandboxDriver.driver({
				...rest,
				capabilities: { ...rest.capabilities, wake: false },
			});

			const exit = yield* Effect.exit(SandboxDriverRegistry.make([undeclaredWake]));
			const error = failure(exit);
			expect(error).toBeInstanceOf(SandboxDriverRegistrationError);
			expect((error as SandboxDriverRegistrationError).reason).toContain("wake");
		}),
	);
});
