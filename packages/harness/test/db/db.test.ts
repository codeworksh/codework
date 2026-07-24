import { NodeFileSystem } from "@effect/platform-node";
import { DateTime, Effect, FileSystem, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import path from "node:path";
import { describe, expect } from "vite-plus/test";
import { Database, SqlSchema } from "../../src/db/db";
import { ProjectDirectoryRow, ProjectRow } from "../../src/db/schema.sql";
import { SandboxInstance } from "../../src/sandbox/instance";
import { SandboxStore } from "../../src/sandbox/store";
import { AbsolutePath } from "../../src/schema";
import { testEffect } from "../utils/effect";

const layer = Layer.unwrap(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const dir = yield* fs.makeTempDirectoryScoped();
		return Database.layer(path.join(dir, "test.db"));
	}),
).pipe(Layer.provide(NodeFileSystem.layer));

const { effect: it } = testEffect(layer);

// `:memory:` must behave like any other database — better-sqlite3 keeps a
// single connection per layer, so the data survives transactions. (The
// previous libsql client swapped connections inside `transaction()`, which
// silently replaced an in-memory database with an empty one.)
const { effect: memoryIt } = testEffect(Database.layer(":memory:"));

// Model-encoded queries shared by the tests; column names derive from the
// camelCase field names via the client's name transforms.
const queries = (sql: SqlClient.SqlClient) => ({
	insertProject: SqlSchema.void({
		Request: ProjectRow.insert,
		execute: (row) => sql`INSERT INTO project ${sql.insert(row)}`,
	}),
	findProject: SqlSchema.findOneOption({
		Request: ProjectRow.fields.id,
		Result: ProjectRow,
		execute: (id) => sql`SELECT * FROM project WHERE id = ${id}`,
	}),
	insertDirectory: SqlSchema.void({
		Request: ProjectDirectoryRow.insert,
		execute: (row) => sql`INSERT INTO project_directory ${sql.insert(row)}`,
	}),
	selectDirectories: SqlSchema.findAll({
		Request: ProjectRow.fields.id,
		Result: ProjectDirectoryRow,
		execute: (projectId) => sql`SELECT * FROM project_directory WHERE project_id = ${projectId} ORDER BY id`,
	}),
});

// Directories and sessions are foreign-keyed to sandbox_instance, so a namespace
// has to exist before anything can claim to live in it. Registering here keeps
// these tests about the schema rather than about the Controller.
const instance = (id: string) => SandboxInstance.ID.make(id);

const registerInstances = (...ids: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const store = yield* SandboxStore.make;
		yield* Effect.forEach(ids, (id) =>
			store.register({ id: instance(id), driver: "memory", kind: "virtual", ownership: "managed" }),
		);
	});

describe("Database", () => {
	describe("models", () => {
		it(
			"round-trips a project through the migrated schema",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const db = queries(sql);
				yield* registerInstances("sandbox-1", "sandbox-2", "sandbox-orphan");

				const project = yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "codework" });
				yield* db.insertProject(project);

				const found = yield* db.findProject("project-1");
				expect(Option.isSome(found)).toBe(true);
				const row = Option.getOrThrow(found);
				expect(row.name).toBe("codework");
				expect(DateTime.isDateTime(row.createdAt)).toBe(true);
				expect(DateTime.isDateTime(row.updatedAt)).toBe(true);
			}),
		);

		it(
			"inserts and reads a project with its directories",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const db = queries(sql);
				yield* registerInstances("sandbox-1", "sandbox-2", "sandbox-orphan");

				yield* db.insertProject(yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "codework" }));
				yield* db.insertDirectory(
					yield* ProjectDirectoryRow.insert.makeEffect({
						id: "directory-1",
						projectId: "project-1",
						directory: AbsolutePath.make("/workspace/codework"),
						type: "main",
						sandboxInstanceId: instance("sandbox-1"),
					}),
				);
				yield* db.insertDirectory(
					yield* ProjectDirectoryRow.insert.makeEffect({
						id: "directory-2",
						projectId: "project-1",
						directory: AbsolutePath.make("/workspace/codework-feature"),
						type: "gitworktree",
						sandboxInstanceId: instance("sandbox-2"),
					}),
				);

				const directories = yield* db.selectDirectories("project-1");
				expect(
					directories.map((row) => ({
						id: row.id,
						directory: row.directory,
						type: row.type,
						sandboxInstanceId: row.sandboxInstanceId,
					})),
				).toEqual([
					{
						id: "directory-1",
						directory: AbsolutePath.make("/workspace/codework"),
						type: "main",
						sandboxInstanceId: instance("sandbox-1"),
					},
					{
						id: "directory-2",
						directory: AbsolutePath.make("/workspace/codework-feature"),
						type: "gitworktree",
						sandboxInstanceId: instance("sandbox-2"),
					},
				]);
			}),
		);

		it(
			"enforces foreign keys and unique project directories",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const db = queries(sql);
				yield* registerInstances("sandbox-1", "sandbox-2", "sandbox-orphan");

				const orphan = yield* ProjectDirectoryRow.insert.makeEffect({
					id: "orphan",
					projectId: "missing-project",
					directory: AbsolutePath.make("/workspace/orphan"),
					type: "root",
					sandboxInstanceId: instance("sandbox-orphan"),
				});
				const orphanExit = yield* db.insertDirectory(orphan).pipe(Effect.exit);
				expect(orphanExit._tag).toBe("Failure");

				yield* db.insertProject(yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "codework" }));
				yield* db.insertDirectory(
					yield* ProjectDirectoryRow.insert.makeEffect({
						id: "directory-1",
						projectId: "project-1",
						directory: AbsolutePath.make("/workspace/codework"),
						type: "main",
						sandboxInstanceId: instance("sandbox-1"),
					}),
				);

				// The same path in a different sandbox is a different place, so it
				// registers independently rather than colliding.
				const otherEnv = yield* ProjectDirectoryRow.insert.makeEffect({
					id: "directory-2",
					projectId: "project-1",
					directory: AbsolutePath.make("/workspace/codework"),
					type: "root",
					sandboxInstanceId: instance("sandbox-2"),
				});
				const otherEnvExit = yield* db.insertDirectory(otherEnv).pipe(Effect.exit);
				expect(otherEnvExit._tag).toBe("Success");

				// The same path in the same sandbox is a genuine duplicate.
				const duplicate = yield* ProjectDirectoryRow.insert.makeEffect({
					id: "directory-3",
					projectId: "project-1",
					directory: AbsolutePath.make("/workspace/codework"),
					type: "root",
					sandboxInstanceId: instance("sandbox-1"),
				});
				const duplicateExit = yield* db.insertDirectory(duplicate).pipe(Effect.exit);
				expect(duplicateExit._tag).toBe("Failure");
			}),
		);

		it(
			"deletes project directories when their project is deleted",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const db = queries(sql);
				yield* registerInstances("sandbox-1", "sandbox-2", "sandbox-orphan");

				yield* db.insertProject(yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "codework" }));
				yield* db.insertDirectory(
					yield* ProjectDirectoryRow.insert.makeEffect({
						id: "directory-1",
						projectId: "project-1",
						directory: AbsolutePath.make("/workspace/codework"),
						type: "main",
						sandboxInstanceId: instance("sandbox-1"),
					}),
				);

				yield* sql`DELETE FROM project WHERE id = ${"project-1"}`;

				const directories = yield* db.selectDirectories("project-1");
				expect(directories).toEqual([]);
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

				yield* db.insertProject(yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "codework" }));

				yield* sql.withTransaction(
					Effect.gen(function* () {
						// transactions are statement-based (BEGIN/COMMIT on the same
						// connection), so crossing an async boundary is fine — the
						// old drizzle wrapper had to forbid this
						yield* Effect.promise(() => Promise.resolve());
						yield* db.insertProject(yield* ProjectRow.insert.makeEffect({ id: "project-2", name: "widget" }));
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

				yield* db.insertProject(yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "codework" }));

				const exit = yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* db.insertProject(yield* ProjectRow.insert.makeEffect({ id: "project-2", name: "widget" }));
							// duplicate primary key forces the transaction to fail
							yield* db.insertProject(yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "dupe" }));
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
