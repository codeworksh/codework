import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import path from "node:path";
import { describe, expect } from "vite-plus/test";
import { Database } from "../../src/db/db.ts";
import { ProjectRow, SpaceRow } from "../../src/db/schema.sql.ts";
import { SandboxInstance } from "../../src/sandbox/instance.ts";
import { SandboxStore } from "../../src/sandbox/store.ts";
import { AbsolutePath } from "../../src/schema.ts";
import { testEffect } from "../utils/effect.ts";

const layer = Layer.unwrap(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const dir = yield* fs.makeTempDirectoryScoped();
		return Database.layer(path.join(dir, "test.db"));
	}),
).pipe(Layer.provide(NodeFileSystem.layer));

const { effect: it } = testEffect(layer);

// `:memory:` must behave like any other database — the node:sqlite client keeps
// a single connection per layer, so the data survives transactions. (The
// previous libsql client swapped connections inside `transaction()`, which
// silently replaced an in-memory database with an empty one.)
const { effect: memoryIt } = testEffect(Database.layer(":memory:"));

// Model-encoded queries shared by the tests; column names derive from the
// camelCase field names via the client's name transforms.
const queries = (sql: SqlClient.SqlClient) => ({
	insertProject: Database.SqlSchema.void({
		Request: ProjectRow.insert,
		execute: (row) => sql`INSERT INTO project ${sql.insert(row)}`,
	}),
	findProject: Database.SqlSchema.findOneOption({
		Request: ProjectRow.fields.id,
		Result: ProjectRow,
		execute: (id) => sql`SELECT * FROM project WHERE id = ${id}`,
	}),
	insertSpace: Database.SqlSchema.void({
		Request: SpaceRow.insert,
		execute: (row) => sql`INSERT INTO space ${sql.insert(row)}`,
	}),
	selectSpaces: Database.SqlSchema.findAll({
		Request: ProjectRow.fields.id,
		Result: SpaceRow,
		execute: (projectId) => sql`SELECT * FROM space WHERE project_id = ${projectId} ORDER BY id`,
	}),
});

// Spaces are foreign-keyed to sandbox_instance, so a namespace has to exist
// before anything can claim to live in it. Registering here keeps these tests
// about the schema rather than about the Controller.
const instanceId = (id: string) => SandboxInstance.ID.make(id);
// Row models carry the namespace as an Option, since NULL is the host.
const instance = (id: string) => SandboxInstance.toField(instanceId(id));

const space = (input: {
	readonly id: string;
	readonly projectId: string;
	readonly location: string;
	readonly kind: SpaceRow["kind"];
	readonly env: string;
}) =>
	SpaceRow.insert.makeEffect({
		id: input.id,
		projectId: input.projectId,
		location: AbsolutePath.make(input.location),
		kind: input.kind,
		env: instance(input.env),
		status: "active",
	});

const registerInstances = (...ids: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const store = yield* SandboxStore.make;
		yield* Effect.forEach(ids, (id) =>
			store.register({ id: instanceId(id), driver: "memory", kind: "virtual", ownership: "managed" }),
		);
	});

describe("Database", () => {
	describe("models", () => {
		it(
			"enforces foreign keys, one row per place, and one primary per env",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const db = queries(sql);
				yield* registerInstances("sandbox-1", "sandbox-2", "sandbox-orphan");

				const orphan = yield* space({
					id: "orphan",
					projectId: "missing-project",
					location: "/workspace/orphan",
					kind: "plain",
					env: "sandbox-orphan",
				});
				const orphanExit = yield* db.insertSpace(orphan).pipe(Effect.exit);
				expect(orphanExit._tag).toBe("Failure");

				yield* db.insertProject(
					yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "codework", status: "active" }),
				);
				yield* db.insertSpace(
					yield* space({
						id: "space-1",
						projectId: "project-1",
						location: "/workspace/codework",
						kind: "primary",
						env: "sandbox-1",
					}),
				);

				// The same path in a different sandbox is a different place, so it
				// registers independently — and may be that env's primary.
				const otherEnv = yield* space({
					id: "space-2",
					projectId: "project-1",
					location: "/workspace/codework",
					kind: "primary",
					env: "sandbox-2",
				});
				const otherEnvExit = yield* db.insertSpace(otherEnv).pipe(Effect.exit);
				expect(otherEnvExit._tag).toBe("Success");

				// The same path in the same sandbox is a genuine duplicate.
				const duplicate = yield* space({
					id: "space-3",
					projectId: "project-1",
					location: "/workspace/codework",
					kind: "copy",
					env: "sandbox-1",
				});
				const duplicateExit = yield* db.insertSpace(duplicate).pipe(Effect.exit);
				expect(duplicateExit._tag).toBe("Failure");

				// A second primary in the same (project, env) is refused.
				const secondPrimary = yield* space({
					id: "space-4",
					projectId: "project-1",
					location: "/workspace/codework-clone",
					kind: "primary",
					env: "sandbox-1",
				});
				const secondPrimaryExit = yield* db.insertSpace(secondPrimary).pipe(Effect.exit);
				expect(secondPrimaryExit._tag).toBe("Failure");
			}),
		);

		it(
			"restricts deleting a project that still has spaces",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const db = queries(sql);
				yield* registerInstances("sandbox-1", "sandbox-2", "sandbox-orphan");

				yield* db.insertProject(
					yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "codework", status: "active" }),
				);
				yield* db.insertSpace(
					yield* space({
						id: "space-1",
						projectId: "project-1",
						location: "/workspace/codework",
						kind: "primary",
						env: "sandbox-1",
					}),
				);

				const exit = yield* sql`DELETE FROM project WHERE id = ${"project-1"}`.pipe(Effect.exit);
				expect(exit._tag).toBe("Failure");
				expect(yield* db.selectSpaces("project-1")).toHaveLength(1);
			}),
		);
	});

	describe(":memory:", () => {
		memoryIt(
			"keeps an in-memory database intact across transactions",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const db = queries(sql);
				yield* registerInstances("sandbox-1", "sandbox-2", "sandbox-orphan");

				yield* db.insertProject(
					yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "codework", status: "active" }),
				);

				yield* sql.withTransaction(
					Effect.gen(function* () {
						// transactions are statement-based (BEGIN/COMMIT on the same
						// connection), so crossing an async boundary is fine — the
						// old drizzle wrapper had to forbid this
						yield* Effect.promise(() => Promise.resolve());
						yield* db.insertProject(
							yield* ProjectRow.insert.makeEffect({ id: "project-2", name: "widget", status: "active" }),
						);
					}),
				);

				const rows = yield* sql`SELECT id FROM project ORDER BY id`;
				expect(rows.map((row) => row.id)).toEqual(["project-1", "project-2"]);
			}),
		);

		memoryIt(
			"rolls back a failed transaction without losing the database",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const db = queries(sql);
				yield* registerInstances("sandbox-1", "sandbox-2", "sandbox-orphan");

				yield* db.insertProject(
					yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "codework", status: "active" }),
				);

				const exit = yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* db.insertProject(
								yield* ProjectRow.insert.makeEffect({ id: "project-2", name: "widget", status: "active" }),
							);
							// duplicate primary key forces the transaction to fail
							yield* db.insertProject(
								yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "dupe", status: "active" }),
							);
						}),
					)
					.pipe(Effect.exit);
				expect(exit._tag).toBe("Failure");

				const rows = yield* sql`SELECT id FROM project`;
				expect(rows.map((row) => row.id)).toEqual(["project-1"]);
			}),
		);
	});
});
