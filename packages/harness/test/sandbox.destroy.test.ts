import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { SandboxController } from "../src/sandbox/control.ts";
import { SandboxDriver } from "../src/sandbox/driver.ts";
import { FakeSandboxDriver } from "../src/sandbox/drivers/fake.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { SandboxDriverRegistry } from "../src/sandbox/registry.ts";
import { testEffect } from "./utils/effect.ts";

const fake = FakeSandboxDriver.make(SandboxDriver.Name.make("destroy-fake"));
const dependencies = Layer.merge(Database.layer(":memory:"), SandboxDriverRegistry.layer(fake.driver));
const { effect: it } = testEffect(Layer.provideMerge(SandboxController.layer(), dependencies));

const createStopped = Effect.gen(function* () {
	const controller = yield* SandboxController.Controller;
	const info = yield* controller.create({
		driver: fake.driver,
		config: { defaultCwd: SandboxDriver.AbsolutePath.make("/workspace") },
	});
	yield* controller.stop(info.id);
	return info.id;
});

const seed = (project: string, spaces: ReadonlyArray<{ id: string; env: SandboxInstance.ID }>) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT INTO project (id, name, status, created_at, updated_at) VALUES (${project}, ${project}, 'active', 0, 0)`;
		for (const space of spaces) {
			yield* sql`
				INSERT INTO space (id, project_id, location, kind, env, status, created_at, updated_at)
				VALUES (${space.id}, ${project}, ${`/${space.id}`}, 'plain', ${SandboxInstance.toColumn(space.env)}, 'active', 0, 0)
			`;
		}
	});

const status = (table: "space" | "project", id: string) =>
	Effect.map(
		Effect.flatMap(
			SqlClient.SqlClient,
			(sql) => sql<{ status: string }>`SELECT status FROM ${sql(table)} WHERE id = ${id}`,
		),
		(rows) => rows[0]?.status,
	);

// D-ENV / S30: the tombstone and the env's space archival are one transaction.
describe("Sandbox.Controller.destroy", () => {
	it(
		"archives the env's spaces and the project when nothing active remains",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const env = yield* createStopped;
			yield* seed("p-orphaned", [{ id: "s-env", env }]);

			yield* controller.destroy(env);

			expect(yield* status("space", "s-env")).toBe("archived");
			expect(yield* status("project", "p-orphaned")).toBe("archived");
		}),
	);

	it(
		"leaves host spaces and their project active",
		Effect.gen(function* () {
			const controller = yield* SandboxController.Controller;
			const env = yield* createStopped;
			const other = yield* createStopped;
			yield* seed("p-shared", [
				{ id: "s-env-2", env },
				{ id: "s-host", env: SandboxInstance.ID.local },
				{ id: "s-other", env: other },
			]);

			yield* controller.destroy(env);

			expect(yield* status("space", "s-env-2")).toBe("archived");
			expect(yield* status("space", "s-host")).toBe("active");
			expect(yield* status("space", "s-other")).toBe("active");
			expect(yield* status("project", "p-shared")).toBe("active");
		}),
	);

	it(
		"does not archive on stop",
		Effect.gen(function* () {
			const env = yield* createStopped;
			yield* seed("p-stopped", [{ id: "s-stopped", env }]);

			expect(yield* status("space", "s-stopped")).toBe("active");
			expect(yield* status("project", "p-stopped")).toBe("active");
		}),
	);
});
