import { Effect, Layer, Option } from "effect";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { SandboxController } from "../src/sandbox/control.ts";
import { SandboxDriver } from "../src/sandbox/driver.ts";
import { SandboxDriverRegistry } from "../src/sandbox/registry.ts";
import { MemorySandboxDriver } from "../src/sandbox/drivers/memory.ts";
import { SqldbSandboxDriver } from "../src/sandbox/drivers/sqldb.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import { testEffect } from "./utils/effect.ts";

const processLocalLifecycle = <CreateConfig, RuntimeConfig extends SandboxDriver.RuntimeConfigBase>(
	name: string,
	fixture: {
		readonly driver: SandboxDriver.Driver<CreateConfig, RuntimeConfig> & SandboxDriver.Registration;
		readonly config: CreateConfig;
	},
) => {
	const dependencies = Layer.merge(Database.layer(":memory:"), SandboxDriverRegistry.layer(fixture.driver));
	const runtime = Layer.provideMerge(
		SandboxController.layer({ hostCwd: "/", transportIdleTimeToLive: "1 hour" }),
		dependencies,
	);
	const { effect: it } = testEffect(runtime);

	describe(name, () => {
		it(
			"retains namespace state across stop and deletes it only on destroy",
			Effect.gen(function* () {
				const controller = yield* SandboxController.Controller;
				const created = yield* controller.create({
					driver: fixture.driver,
					config: fixture.config,
				});

				yield* Effect.flatMap(SandboxIO.FileSystem, (fs) => fs.writeFile("/workspace/marker.txt", "retained")).pipe(
					Effect.provide(controller.mount(created.id)),
					Effect.scoped,
				);

				const stopped = yield* controller.stop(created.id);
				expect(stopped.status).toBe("offline");
				expect(stopped.providerStatus).toEqual(Option.some("retained"));

				const woken = yield* controller.wake(created.id);
				expect(woken.status).toBe("online");
				expect(woken.providerStatus).toEqual(Option.some("online"));
				expect((yield* controller.stop(created.id)).status).toBe("offline");

				const remounted = yield* Effect.gen(function* () {
					const fs = yield* SandboxIO.FileSystem;
					const current = Option.getOrThrow(yield* controller.get(created.id));
					return {
						content: yield* fs.readFile("/workspace/marker.txt"),
						refCount: current.refCount,
						status: current.status,
					};
				}).pipe(Effect.provide(controller.mount(created.id)), Effect.scoped);

				expect(remounted).toEqual({
					content: "retained",
					refCount: 1,
					status: "online",
				});
				expect(Option.getOrThrow(yield* controller.get(created.id)).refCount).toBe(0);

				yield* controller.stop(created.id);
				yield* controller.destroy(created.id);
				expect(Option.getOrThrow(yield* controller.get(created.id)).status).toBe("removed");
			}),
		);
	});
};

const memory = MemorySandboxDriver.make();
processLocalLifecycle("memory driver lifecycle", {
	driver: memory.driver,
	config: {
		defaultCwd: SandboxDriver.AbsolutePath.make("/workspace"),
		initializeCwd: SandboxDriver.AbsolutePath.make("/workspace"),
	},
});

const sqldb = SqldbSandboxDriver.make();
processLocalLifecycle("in-memory sqldb driver lifecycle", {
	driver: sqldb.driver,
	config: {
		defaultCwd: SandboxDriver.AbsolutePath.make("/workspace"),
		initializeCwd: SandboxDriver.AbsolutePath.make("/workspace"),
	},
});
