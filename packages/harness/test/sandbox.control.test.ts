import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db";
import { SandboxController } from "../src/sandbox/control";
import { SandboxDriver } from "../src/sandbox/driver";
import { FakeSandboxDriver } from "../src/sandbox/drivers/fake";
import {
	SandboxBusyError,
	SandboxDriverNotRegisteredError,
	SandboxMustBeStoppedError,
	SandboxProviderError,
	SandboxRemovedError,
	SandboxUnavailError,
	SandboxUnsupportedError,
} from "../src/sandbox/errors";
import { SandboxInstance } from "../src/sandbox/instance";
import { SandboxIO } from "../src/sandbox/io";
import { SandboxStore } from "../src/sandbox/store";
import { testEffect } from "./utils/effect";

const fake = FakeSandboxDriver.make(SandboxDriver.Name.make("control-fake"));
const dependencies = Layer.merge(Database.layer(":memory:"), SandboxDriver.layer(fake.driver));
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

describe("Sandbox.Controller", () => {
	it(
		"synthesizes and mounts the row-free host",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const host = Option.getOrThrow(yield* controller.get(SandboxInstance.ID.local));
			expect(host.id).toBe(SandboxInstance.ID.local);
			expect(host.usage).toBe("pinned");
			expect(host.refCount).toBe(0);
			expect((yield* controller.list()).filter((info) => info.id === SandboxInstance.ID.local)).toHaveLength(1);

			const current = yield* Effect.gen(function* () {
				const identity = yield* SandboxIO.Current;
				const fs = yield* SandboxIO.FileSystem;
				expect(yield* fs.exists(identity.cwd)).toBe(true);
				return identity;
			}).pipe(Effect.provide(controller.mount()), Effect.scoped);

			expect(current.id).toBe(SandboxInstance.ID.local);
			expect(current.kind).toBe("local");
		}),
	);

	it(
		"creates durable metadata without mounting or inspecting",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const inspectCalls = fake.state.calls.inspect.length;
			const attachCalls = fake.state.calls.attach.length;
			const info = yield* create(controller);

			expect(info.status).toBe("online");
			expect(info.usage).toBe("idle");
			expect(info.refCount).toBe(0);
			expect(Option.getOrThrow(info.providerResourceId)).toBe(`fake:${info.id}`);
			expect(fake.state.calls.inspect).toHaveLength(inspectCalls);
			expect(fake.state.calls.attach).toHaveLength(attachCalls);

			const stored = Option.getOrThrow(yield* controller.get(info.id));
			expect(stored).toEqual(info);
		}),
	);

	it(
		"persists a create failure as faulted and returns the sanitized provider error",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			fake.state.failNext("create", new Error("provisioning failed"));
			const result = yield* Effect.exit(create(controller));
			expect(failure(result)).toBeInstanceOf(SandboxProviderError);

			const faulted = (yield* controller.list({ driver: fake.driver.name })).filter(
				(info) => info.status === "faulted",
			);
			expect(faulted.length).toBeGreaterThan(0);
			expect(Option.getOrThrow(faulted.at(-1)!.lastError).message).toContain("provisioning failed");
		}),
	);

	it(
		"reads rows whose driver is unavailable and fails only when mounting",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const store = yield* SandboxStore.make;
			const id = SandboxInstance.ID.create();
			yield* store.register({
				id,
				driver: "not-configured",
				kind: "remote",
				ownership: "managed",
				runtimeConfig: JSON.stringify({ defaultCwd: "/workspace" }),
			});

			expect(Option.getOrThrow(yield* controller.get(id)).driver).toBe("not-configured");
			expect((yield* controller.list()).some((info) => info.id === id)).toBe(true);

			const mounted = Effect.flatMap(SandboxIO.Current, Effect.succeed).pipe(
				Effect.provide(controller.mount(id)),
				Effect.scoped,
				Effect.exit,
			);
			expect(failure(yield* mounted)).toBeInstanceOf(SandboxDriverNotRegisteredError);
		}),
	);

	it(
		"shares one cwd-neutral transport across concurrent mounts",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const info = yield* create(controller, "/");
			const before = fake.state.calls.attach.length;

			yield* Effect.flatMap(SandboxIO.FileSystem, (fs) => Effect.all([fs.mkdir("/alpha"), fs.mkdir("/beta")])).pipe(
				Effect.provide(controller.mount(info.id)),
				Effect.scoped,
			);

			const work = (cwd: string, marker: string) =>
				Effect.gen(function* () {
					const fs = yield* SandboxIO.FileSystem;
					const shell = yield* SandboxIO.Shell;
					const current = yield* SandboxIO.Current;
					yield* fs.writeFile("marker.txt", marker);
					const observed = Option.getOrThrow(yield* controller.get(info.id));
					return {
						cwd: current.cwd,
						pwd: (yield* shell.exec("pwd")).stdout.trim(),
						refCount: observed.refCount,
					};
				}).pipe(Effect.provide(controller.mount(info.id, { cwd })), Effect.scoped);

			const mounted = yield* Effect.all([work("/alpha", "a"), work("/beta", "b")], {
				concurrency: "unbounded",
			});
			expect(mounted.map((entry) => entry.cwd).sort()).toEqual(["/alpha", "/beta"]);
			expect(mounted.map((entry) => entry.pwd).sort()).toEqual(["/alpha", "/beta"]);
			expect(mounted.map((entry) => entry.refCount)).toEqual([2, 2]);

			// The first mount built the transport; the later mounts reused it.
			expect(fake.state.calls.attach.length - before).toBe(1);
			expect(Option.getOrThrow(yield* controller.get(info.id)).refCount).toBe(0);

			const markers = yield* Effect.gen(function* () {
				const fs = yield* SandboxIO.FileSystem;
				return yield* Effect.all([fs.readFile("/alpha/marker.txt"), fs.readFile("/beta/marker.txt")]);
			}).pipe(Effect.provide(controller.mount(info.id)), Effect.scoped);
			expect(markers).toEqual(["a", "b"]);
		}),
	);

	it(
		"retries one stale attachment before recording a fault",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const info = yield* create(controller);
			const before = fake.state.calls.attach.length;
			fake.state.failNext("attach", new Error("expired session"));

			const current = yield* Effect.flatMap(SandboxIO.Current, Effect.succeed).pipe(
				Effect.provide(controller.mount(info.id)),
				Effect.scoped,
			);
			expect(current.id).toBe(info.id);
			expect(fake.state.calls.attach.length - before).toBe(2);
			expect(Option.getOrThrow(yield* controller.get(info.id)).status).toBe("online");
		}),
	);

	it(
		"records an authoritative missing resource as unavail until managed destroy tombstones it",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const info = yield* create(controller);
			fake.state.remove(info.id);

			const result = yield* Effect.exit(controller.refresh(info.id));
			expect(failure(result)).toBeInstanceOf(SandboxUnavailError);
			const stored = Option.getOrThrow(yield* controller.get(info.id));
			expect(stored.status).toBe("unavail");
			expect(Option.isNone(stored.removedAt)).toBe(true);

			fake.state.failNext("destroy", new Error("delete failed"));
			expect(failure(yield* Effect.exit(controller.destroy(info.id)))).toBeInstanceOf(SandboxProviderError);
			expect(Option.getOrThrow(yield* controller.get(info.id)).status).toBe("unavail");

			yield* controller.destroy(info.id);
			const removed = Option.getOrThrow(yield* controller.get(info.id));
			expect(removed.status).toBe("removed");
			expect(Option.isSome(removed.removedAt)).toBe(true);
		}),
	);

	it(
		"refreshes through inspect without attaching or waking",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const info = yield* create(controller);
			fake.state.resources.get(info.id)!.status = "offline";
			const attachCalls = fake.state.calls.attach.length;
			const wakeCalls = fake.state.calls.wake.length;

			const refreshed = yield* controller.refresh(info.id);
			expect(refreshed.status).toBe("offline");
			expect(fake.state.calls.attach).toHaveLength(attachCalls);
			expect(fake.state.calls.wake).toHaveLength(wakeCalls);
		}),
	);

	it(
		"registers one external identity per driver resource",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const originalId = SandboxInstance.ID.create();
			const provisioned = yield* fake.driver.create({
				instanceId: originalId,
				config: { defaultCwd: SandboxDriver.AbsolutePath.make("/external") },
			});
			const providerResourceId = provisioned.providerResourceId!;

			const first = yield* controller.register({
				driver: fake.driver,
				providerResourceId,
			});
			const second = yield* controller.register({
				driver: fake.driver,
				providerResourceId,
			});
			expect(second.id).toBe(first.id);
			expect(first.ownership).toBe("external");

			const mounted = yield* Effect.flatMap(SandboxIO.Current, Effect.succeed).pipe(
				Effect.provide(controller.mount(first.id)),
				Effect.scoped,
			);
			expect(mounted.id).toBe(first.id);

			expect(failure(yield* Effect.exit(controller.destroy(first.id)))).toBeInstanceOf(SandboxUnsupportedError);
		}),
	);

	it(
		"keeps unmount, stop, and destroy as separate guarded operations",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const info = yield* create(controller);

			yield* Effect.gen(function* () {
				const current = Option.getOrThrow(yield* controller.get(info.id));
				expect(current.usage).toBe("busy");
				expect(failure(yield* Effect.exit(controller.destroy(info.id)))).toBeInstanceOf(SandboxBusyError);
			}).pipe(Effect.provide(controller.mount(info.id)), Effect.scoped);

			expect(Option.getOrThrow(yield* controller.get(info.id)).usage).toBe("idle");
			expect(failure(yield* Effect.exit(controller.destroy(info.id)))).toBeInstanceOf(SandboxMustBeStoppedError);

			const stopped = yield* controller.stop(info.id);
			expect(stopped.status).toBe("offline");
			yield* controller.destroy(info.id);

			const removed = Option.getOrThrow(yield* controller.get(info.id));
			expect(removed.status).toBe("removed");
			expect(Option.isSome(removed.removedAt)).toBe(true);
			const remount = Effect.flatMap(SandboxIO.Current, Effect.succeed).pipe(
				Effect.provide(controller.mount(info.id)),
				Effect.scoped,
			);
			expect(failure(yield* Effect.exit(remount))).toBeInstanceOf(SandboxRemovedError);
		}),
	);

	it(
		"persists a destroy failure as offline and allows a retry",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const info = yield* create(controller);
			yield* controller.stop(info.id);
			fake.state.failNext("destroy", new Error("delete failed"));

			expect(failure(yield* Effect.exit(controller.destroy(info.id)))).toBeInstanceOf(SandboxProviderError);
			const failed = Option.getOrThrow(yield* controller.get(info.id));
			expect(failed.status).toBe("offline");
			expect(Option.getOrThrow(failed.lastError).message).toContain("delete failed");

			yield* controller.destroy(info.id);
			expect(Option.getOrThrow(yield* controller.get(info.id)).status).toBe("removed");
		}),
	);

	it(
		"never lets force bypass capability or the stopped requirement",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			expect(
				failure(
					yield* Effect.exit(
						controller.destroy(SandboxInstance.ID.local, {
							force: true,
						}),
					),
				),
			).toBeInstanceOf(SandboxUnsupportedError);

			const info = yield* create(controller);
			expect(failure(yield* Effect.exit(controller.destroy(info.id, { force: true })))).toBeInstanceOf(
				SandboxMustBeStoppedError,
			);
		}),
	);

	it(
		"reports references as process-local",
		Effect.gen(function* () {
			const first = yield* SandboxController.Controller;
			const second = yield* SandboxController.make({ transportIdleTimeToLive: "1 hour" });
			const info = yield* create(first);

			yield* Effect.gen(function* () {
				expect(Option.getOrThrow(yield* first.get(info.id)).usage).toBe("busy");
				expect(Option.getOrThrow(yield* second.get(info.id)).usage).toBe("idle");
			}).pipe(Effect.provide(first.mount(info.id)), Effect.scoped);
		}),
	);

	it(
		"createAndMount releases its first reference with the layer scope",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const instanceId = yield* Effect.gen(function* () {
				const current = yield* SandboxIO.Current;
				expect(Option.getOrThrow(yield* controller.get(current.id)).usage).toBe("busy");
				return current.id;
			}).pipe(
				Effect.provide(
					controller.createAndMount({
						driver: fake.driver,
						config: { defaultCwd: SandboxDriver.AbsolutePath.make("/workspace") },
					}),
				),
				Effect.scoped,
			);

			expect(Option.getOrThrow(yield* controller.get(instanceId)).usage).toBe("idle");
		}),
	);

	it(
		"createAndMount reserves its reference before provider creation",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const instanceId = SandboxInstance.ID.create();
			const started = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			fake.state.blockNext(
				"create",
				Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
			);

			yield* Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					Layer.build(
						controller.createAndMount({
							driver: fake.driver,
							config: { defaultCwd: SandboxDriver.AbsolutePath.make("/workspace") },
							instanceId,
						}),
					),
				);
				yield* Deferred.await(started);

				const provisioning = Option.getOrThrow(yield* controller.get(instanceId));
				expect(provisioning.status).toBe("provisioning");
				expect(provisioning.usage).toBe("busy");
				expect(provisioning.refCount).toBe(1);

				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(fiber);
				expect(Option.getOrThrow(yield* controller.get(instanceId)).refCount).toBe(1);
			}).pipe(Effect.scoped);

			expect(Option.getOrThrow(yield* controller.get(instanceId)).refCount).toBe(0);
		}),
	);

	it(
		"sweeps a stranded provisioning row when a control plane starts",
		Effect.gen(function* () {
			const store = yield* SandboxStore.make;
			const sql = yield* SqlClient.SqlClient;
			const instanceId = SandboxInstance.ID.create();
			yield* store.register({
				id: instanceId,
				driver: fake.driver.name,
				kind: fake.driver.kind,
				ownership: "managed",
				status: "provisioning",
			});
			yield* sql`UPDATE sandbox_instance SET state_observed_at = -1000 WHERE id = ${instanceId}`;

			const restarted = yield* SandboxController.make({ provisioningTimeoutMs: 1 });
			const swept = Option.getOrThrow(yield* restarted.get(instanceId));
			expect(swept.status).toBe("faulted");
			expect(Option.getOrThrow(swept.lastError).name).toBe("SandboxCreationInterrupted");
		}),
	);
});
