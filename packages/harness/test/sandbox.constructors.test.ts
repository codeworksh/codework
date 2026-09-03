import { Cause, Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { Event } from "../src/event/event.ts";
import { SandboxController } from "../src/sandbox/control.ts";
import { SandboxDriver } from "../src/sandbox/driver.ts";
import { SandboxDriverRegistry } from "../src/sandbox/registry.ts";
import { MemorySandboxDriver } from "../src/sandbox/drivers/memory.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { AbsolutePath } from "../src/schema.ts";
import { Session } from "../src/session/session.ts";
import { testEffect } from "./utils/effect.ts";

/**
 * `Sandbox.memory()` / `Sandbox.sqldb()` are isolated test/script mounts: each
 * builds a private controller over a throwaway `:memory:` control-plane
 * database. Their instance ids therefore have no row in the application
 * database — and the application database *rejects* such a reference at the
 * foreign key, loudly, rather than accepting a dangling one. The supported
 * application path is registering the same driver with the shared controller
 * and creating the namespace there.
 */

const memory = MemorySandboxDriver.make();
const database = Database.layer(":memory:");
const infrastructure = Layer.provideMerge(
	SandboxController.layer().pipe(Layer.provide(SandboxDriverRegistry.layer(memory.driver))),
	database,
);
const runtime = Session.layer.pipe(Layer.provideMerge(Event.layer), Layer.provideMerge(infrastructure));
const { effect: it } = testEffect(runtime);

const insertProject = Effect.fnUntraced(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('ctor', 'ctor', 0, 0)`;
});

describe("Sandbox convenience constructors vs the application database", () => {
	it(
		"rejects a Sandbox.memory() instance id at the foreign key instead of dangling",
		Effect.gen(function* () {
			const instanceId = SandboxInstance.ID.create();

			// The id is real and live — in its own private control plane.
			const marker = yield* Effect.gen(function* () {
				const current = yield* SandboxIO.Current;
				const fs = yield* SandboxIO.FileSystem;
				yield* fs.writeFile("marker.txt", "isolated");
				return { id: current.id, content: yield* fs.readFile("/workspace/marker.txt") };
			}).pipe(Effect.provide(Sandbox.memory({ instanceId, cwd: "/workspace" })), Effect.scoped);
			expect(marker.id).toBe(instanceId);
			expect(marker.content).toBe("isolated");

			// The application database has no such row, so the reference is refused.
			yield* insertProject();
			const sessions = yield* Session.Service;
			const exit = yield* Effect.exit(
				sessions.create({
					projectId: "ctor",
					slug: `ctor-reject-${Date.now()}`,
					directory: AbsolutePath.make("/workspace"),
					title: "isolated namespace",
					sandboxInstanceId: instanceId,
				}),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				expect(Cause.pretty(exit.cause)).toContain("FOREIGN KEY");
			}

			// Rejected means rejected: no dangling row was persisted.
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql`SELECT id FROM session WHERE sandbox_instance_id = ${instanceId}`;
			expect(rows).toHaveLength(0);
		}),
	);

	it(
		"accepts the same driver's namespace when created through the shared controller",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const info = yield* controller.create({
				driver: memory.driver,
				config: {
					defaultCwd: SandboxDriver.AbsolutePath.make("/workspace"),
					initializeCwd: SandboxDriver.AbsolutePath.make("/workspace"),
				},
			});

			yield* insertProject();
			const sessions = yield* Session.Service;
			const session = yield* sessions.create({
				projectId: "ctor",
				slug: `ctor-accept-${Date.now()}`,
				directory: AbsolutePath.make("/workspace"),
				title: "shared namespace",
				sandboxInstanceId: info.id,
			});

			expect(SandboxInstance.fromField(session.sandboxInstanceId)).toBe(info.id);
			expect(Option.isSome(yield* controller.get(info.id))).toBe(true);
		}),
	);
});
