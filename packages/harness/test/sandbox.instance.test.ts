import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/db.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { SandboxStore } from "../src/sandbox/store.ts";
import { testEffect } from "./utils/effect.ts";

// A plain database, exactly as Project and Session compose it. Nothing is
// seeded: the host is never a row, so there is nothing to ensure or repair.
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
			"brands ids and reserves the host identity",
			Effect.sync(() => {
				expect(SandboxInstance.ID.local).toBe("local");
				expect(id("anything")).toBe("anything");
				expect(SandboxInstance.ID.create()).toMatch(/^sbx_/);
			}),
		);

		// The mountable set is the predicate every conditional write depends on, so
		// it is asserted exactly rather than sampled.
		it(
			"treats online, offline and faulted as mountable and nothing else",
			Effect.sync(() => {
				expect([...SandboxInstance.mountable].sort()).toEqual(["faulted", "offline", "online"]);

				// offline qualifies because mounting wakes; faulted qualifies because
				// a fault is a usability condition, not an identity one.
				expect(SandboxInstance.isMountable("offline")).toBe(true);
				expect(SandboxInstance.isMountable("faulted")).toBe(true);

				for (const status of ["provisioning", "suspending", "removing", "removed", "unavail"] as const) {
					expect(SandboxInstance.isMountable(status)).toBe(false);
				}
			}),
		);

		// `resuming` would exist to be observed by nothing: mounting wakes, offline
		// is already mountable, and waking needs no claim because it is not
		// destructive. `suspending`/`removing` stay because they *are* claims.
		it(
			"has no resuming status",
			Effect.sync(() => {
				expect(SandboxInstance.Status.literals).not.toContain("resuming");
				expect(SandboxInstance.Status.literals).toContain("suspending");
				expect(SandboxInstance.Status.literals).toContain("removing");
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

		// One mapping, both directions, for both carrier shapes. Runtime code always
		// holds a concrete id and never branches on the host.
		it(
			"maps the host to NULL at the storage boundary and back",
			Effect.sync(() => {
				expect(SandboxInstance.toColumn(SandboxInstance.ID.local)).toBe(null);
				expect(SandboxInstance.fromColumn(null)).toBe(SandboxInstance.ID.local);

				expect(SandboxInstance.toColumn(id("sbx_1"))).toBe("sbx_1");
				expect(SandboxInstance.fromColumn("sbx_1")).toBe("sbx_1");

				expect(Option.isNone(SandboxInstance.toField(SandboxInstance.ID.local))).toBe(true);
				expect(SandboxInstance.fromField(Option.none())).toBe(SandboxInstance.ID.local);
				expect(SandboxInstance.fromField(Option.some(id("sbx_1")))).toBe("sbx_1");
			}),
		);
	});

	describe("schema", () => {
		it(
			"migrates to an empty instance table",
			Effect.gen(function* () {
				expect(yield* (yield* sandboxStore).list).toEqual([]);
			}),
		);

		// The reserved id must have exactly one storage form. A row spelling it
		// would be a second one, silently competing with NULL.
		it(
			"refuses to store the reserved host id",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const insert = sql`
					INSERT INTO sandbox_instance
						(id, driver, kind, ownership, status, state_observed_at, created_at, updated_at)
					VALUES ('local', 'local', 'local', 'external', 'online', 0, 0, 0)
				`;
				expect(Option.isSome(yield* Effect.option(insert))).toBe(false);
			}),
		);

		it(
			"rejects a project directory or session in an unregistered namespace",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedProject;

				const directory = (rowId: string, instanceId: string | null) => sql`
					INSERT INTO project_directory (id, project_id, directory, type, sandbox_instance_id, created_at, updated_at)
					VALUES (${rowId}, 'p', ${`/workspace/${rowId}`}, 'main', ${instanceId}, 0, 0)
				`;
				const session = (rowId: string, instanceId: string | null) => sql`
					INSERT INTO session (id, project_id, slug, directory, title, sandbox_instance_id, created_at, updated_at)
					VALUES (${rowId}, 'p', ${rowId}, '/workspace', 't', ${instanceId}, 0, 0)
				`;

				// positive controls: NULL is the host and needs no registration at
				// all, so the rejections below cannot be passing for another reason.
				yield* directory("ok", null);
				yield* session("ok", null);

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
				const store = yield* sandboxStore;
				yield* seedProject;
				yield* store.register({ id: id("sbx_a"), driver: "memory", kind: "virtual", ownership: "managed" });
				yield* sql`
					INSERT INTO project_directory (id, project_id, directory, type, sandbox_instance_id, created_at, updated_at)
					VALUES ('d', 'p', '/workspace', 'main', 'sbx_a', 0, 0)
				`;

				const deletion = sql`DELETE FROM sandbox_instance WHERE id = 'sbx_a'`;
				expect(Option.isSome(yield* Effect.option(deletion))).toBe(false);
			}),
		);

		// SQLite treats NULLs as distinct in a unique index, so without COALESCE the
		// host could register one path twice. This is the test that catches it.
		it(
			"scopes directory uniqueness by instance, including for the NULL host",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* sandboxStore;
				yield* seedProject;
				yield* store.register({ id: id("sbx_a"), driver: "memory", kind: "virtual", ownership: "managed" });

				const insert = (rowId: string, instanceId: string | null) => sql`
					INSERT INTO project_directory (id, project_id, directory, type, sandbox_instance_id, created_at, updated_at)
					VALUES (${rowId}, 'p', '/workspace', 'main', ${instanceId}, 0, 0)
				`;

				// one path, two namespaces — the host and a registered one
				yield* insert("d1", null);
				yield* insert("d2", "sbx_a");

				// the same pair is rejected in both, NULL included
				expect(Option.isSome(yield* Effect.option(insert("d3", null)))).toBe(false);
				expect(Option.isSome(yield* Effect.option(insert("d4", "sbx_a")))).toBe(false);

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
					id: id("sbx_a"),
					driver: "sqldb",
					kind: "virtual",
					ownership: "managed",
					providerResourceId: "/var/fs.db",
				});

				const alias = sql`
					INSERT INTO sandbox_instance
						(id, driver, kind, provider_resource_id, ownership, status, state_observed_at, created_at, updated_at)
					VALUES ('sbx_b', 'sqldb', 'virtual', '/var/fs.db', 'managed', 'online', 0, 0, 0)
				`;
				expect(Option.isSome(yield* Effect.option(alias))).toBe(false);

				// the index excludes tombstones, so a genuinely new resource may
				// reuse a locator once the old one is gone
				yield* store.transition({ id: id("sbx_a"), from: ["online"], to: "removed" });
				yield* alias;

				expect(yield* store.list).toHaveLength(2);
			}),
		);
	});

	describe("store", () => {
		it(
			"registers idempotently and leaves an existing row untouched",
			Effect.gen(function* () {
				const store = yield* sandboxStore;
				const first = yield* store.register({
					id: id("sbx_m"),
					driver: "memory",
					kind: "virtual",
					ownership: "managed",
				});
				const second = yield* store.register({
					id: id("sbx_m"),
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
				yield* store.register({ id: id("sbx_m"), driver: "memory", kind: "virtual", ownership: "managed" });

				expect(yield* store.transition({ id: id("sbx_m"), from: ["online"], to: "suspending" })).toBe(true);

				// the row has moved on; a competing claim must lose rather than
				// silently overwrite
				expect(yield* store.transition({ id: id("sbx_m"), from: ["online"], to: "removing" })).toBe(false);

				const row = Option.getOrThrow(yield* store.find(id("sbx_m")));
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

		// The insert ignores exactly the idempotency conflict. A *new* id aliasing
		// an existing (driver, provider_resource_id) must fail loudly, not vanish.
		it(
			"fails loudly when a new id aliases an existing driver resource",
			Effect.gen(function* () {
				const store = yield* sandboxStore;
				yield* store.register({
					id: id("sbx_a"),
					driver: "sqldb",
					kind: "virtual",
					ownership: "managed",
					providerResourceId: "/var/fs.db",
				});

				const exit = yield* store
					.register({
						id: id("sbx_b"),
						driver: "sqldb",
						kind: "virtual",
						ownership: "managed",
						providerResourceId: "/var/fs.db",
					})
					.pipe(Effect.exit);

				expect(exit._tag).toBe("Failure");
				expect(Option.isNone(yield* store.find(id("sbx_b")))).toBe(true);
			}),
		);
	});
});
