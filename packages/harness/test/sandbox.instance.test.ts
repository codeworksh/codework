import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db";
import { SandboxInstance } from "../src/sandbox/instance";
import { SandboxStore } from "../src/sandbox/store";
import { testEffect } from "./utils/effect";

const { effect: it } = testEffect(Database.layer(":memory:"));

const id = (value: string) => SandboxInstance.ID.make(value);

const sandboxStore = SandboxStore.make;

const seedProject = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('p', 'p', 0, 0)`;
});

describe("SandboxInstance", () => {
	describe("model", () => {
		it(
			"brands ids and exposes the deterministic local identity",
			Effect.sync(() => {
				expect(SandboxInstance.ID.local).toBe("local");
				expect(id("anything")).toBe("anything");
			}),
		);

		// The acquirable set is the predicate every conditional write depends on,
		// so it is asserted exactly rather than sampled.
		it(
			"treats online, offline and faulted as acquirable and nothing else",
			Effect.sync(() => {
				expect([...SandboxInstance.acquirable].sort()).toEqual(["faulted", "offline", "online"]);

				// offline qualifies because acquisition wakes; faulted qualifies
				// because a fault is a usability condition, not an identity one.
				expect(SandboxInstance.isAcquirable("offline")).toBe(true);
				expect(SandboxInstance.isAcquirable("faulted")).toBe(true);

				for (const status of [
					"provisioning",
					"resuming",
					"suspending",
					"removing",
					"removed",
					"unavail",
				] as const) {
					expect(SandboxInstance.isAcquirable(status)).toBe(false);
				}
			}),
		);

		// `removed` is ours, `unavail` is the driver's claim. Collapsing them would
		// let a misclassified 404 look like a destruction we performed.
		it(
			"keeps removed and unavail distinct",
			Effect.sync(() => {
				expect(SandboxInstance.Status.literals).toContain("removed");
				expect(SandboxInstance.Status.literals).toContain("unavail");
			}),
		);
	});

	describe("schema", () => {
		it(
			"seeds the local instance so foreign keys resolve before any Controller exists",
			Effect.gen(function* () {
				const store = yield* sandboxStore;
				const local = yield* store.find(SandboxInstance.ID.local);

				expect(Option.isSome(local)).toBe(true);
				const row = Option.getOrThrow(local);
				expect(row.driver).toBe("local");
				expect(row.kind).toBe("local");
				expect(row.ownership).toBe("external");
				expect(row.status).toBe("online");
				// an acquirable row must carry a codec-valid runtime config, never NULL
				expect(Option.getOrThrow(row.runtimeConfig)).toBe("{}");
			}),
		);

		it(
			"rejects a project directory or session in an unregistered namespace",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedProject;

				const directory = (rowId: string, instanceId: string) => sql`
					INSERT INTO project_directory (id, project_id, directory, type, sandbox_instance_id, created_at, updated_at)
					VALUES (${rowId}, 'p', ${`/workspace/${rowId}`}, 'main', ${instanceId}, 0, 0)
				`;
				const session = (rowId: string, instanceId: string) => sql`
					INSERT INTO session (id, project_id, slug, directory, title, sandbox_instance_id, created_at, updated_at)
					VALUES (${rowId}, 'p', ${rowId}, '/workspace', 't', ${instanceId}, 0, 0)
				`;

				// positive controls: the same statements must succeed against a
				// registered namespace, so the rejections below cannot be passing
				// for some unrelated reason.
				yield* directory("ok", "local");
				yield* session("ok", "local");

				expect(Option.isSome(yield* Effect.option(directory("bad", "never-registered")))).toBe(false);
				expect(Option.isSome(yield* Effect.option(session("bad", "never-registered")))).toBe(false);
			}),
		);

		// Destroying infrastructure tombstones the row; it never deletes it, so
		// history keeps a valid reference. RESTRICT is what enforces that.
		it(
			"restricts deleting an instance that Project history still references",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedProject;
				yield* sql`
					INSERT INTO project_directory (id, project_id, directory, type, sandbox_instance_id, created_at, updated_at)
					VALUES ('d', 'p', '/workspace', 'main', 'local', 0, 0)
				`;

				const deletion = sql`DELETE FROM sandbox_instance WHERE id = 'local'`;
				expect(Option.isSome(yield* Effect.option(deletion))).toBe(false);
			}),
		);

		it(
			"scopes project directory uniqueness by instance, so one path can exist in two namespaces",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* sandboxStore;
				yield* seedProject;
				yield* store.register({ id: id("other"), driver: "memory", kind: "virtual", ownership: "managed" });

				const insert = (rowId: string, instanceId: string) => sql`
					INSERT INTO project_directory (id, project_id, directory, type, sandbox_instance_id, created_at, updated_at)
					VALUES (${rowId}, 'p', '/workspace', 'main', ${instanceId}, 0, 0)
				`;

				yield* insert("d1", "local");
				yield* insert("d2", "other");

				// same (project, instance, directory) is still rejected
				expect(Option.isSome(yield* Effect.option(insert("d3", "local")))).toBe(false);

				const rows = yield* sql`SELECT * FROM project_directory`;
				expect(rows).toHaveLength(2);
			}),
		);

		// Two application identities for one driver resource would alias — the exact
		// thing instance IDs exist to prevent.
		it(
			"rejects two live instances sharing one driver resource, but not after removal",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* sandboxStore;

				yield* store.register({
					id: id("a"),
					driver: "sqldb",
					kind: "virtual",
					ownership: "managed",
					providerResourceId: "/var/fs.db",
				});

				const alias = sql`
					INSERT INTO sandbox_instance
						(id, driver, kind, provider_resource_id, ownership, status, state_observed_at, created_at, updated_at)
					VALUES ('b', 'sqldb', 'virtual', '/var/fs.db', 'managed', 'online', 0, 0, 0)
				`;
				expect(Option.isSome(yield* Effect.option(alias))).toBe(false);

				// the index excludes tombstones, so a genuinely new resource may
				// reuse a locator once the old one is gone
				yield* store.transition({ id: id("a"), from: ["online"], to: "removed" });
				yield* alias;

				expect(yield* store.list).toHaveLength(3); // local + a + b
			}),
		);
	});

	describe("store", () => {
		it(
			"registers idempotently and leaves an existing row untouched",
			Effect.gen(function* () {
				const store = yield* sandboxStore;
				const first = yield* store.register({
					id: id("m"),
					driver: "memory",
					kind: "virtual",
					ownership: "managed",
				});
				const second = yield* store.register({
					id: id("m"),
					driver: "memory",
					kind: "virtual",
					ownership: "managed",
					status: "faulted",
				});

				expect(second.status).toBe(first.status);
				expect(second.status).toBe("online");
			}),
		);

		it(
			"moves the lifecycle state only from an expected status",
			Effect.gen(function* () {
				const store = yield* sandboxStore;
				yield* store.register({ id: id("m"), driver: "memory", kind: "virtual", ownership: "managed" });

				expect(yield* store.transition({ id: id("m"), from: ["online"], to: "suspending" })).toBe(true);

				// the row has moved on; a competing claim must lose rather than
				// silently overwrite
				expect(yield* store.transition({ id: id("m"), from: ["online"], to: "removing" })).toBe(false);

				const row = Option.getOrThrow(yield* store.find(id("m")));
				expect(row.status).toBe("suspending");
			}),
		);

		it(
			"reports a missing instance as absent rather than failing",
			Effect.gen(function* () {
				const store = yield* sandboxStore;
				expect(Option.isNone(yield* store.find(id("absent")))).toBe(true);
				expect(yield* store.transition({ id: id("absent"), from: ["online"], to: "removed" })).toBe(false);
			}),
		);
	});
});
