import { NodeFileSystem } from "@effect/platform-node";
import { DateTime, Effect, FileSystem, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import path from "node:path";
import { describe, expect } from "vite-plus/test";
import { Database, SqlSchema } from "../../src/db/db";
import { ProjectDirectoryRow, ProjectRow } from "../../src/db/schema.sql";
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

describe("Database", () => {
	describe("models", () => {
		it(
			"round-trips a project through the migrated schema",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const db = queries(sql);

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

				yield* db.insertProject(yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "codework" }));
				yield* db.insertDirectory(
					yield* ProjectDirectoryRow.insert.makeEffect({
						id: "directory-1",
						projectId: "project-1",
						directory: "/workspace/codework",
						type: "main",
						sandboxEnvId: "sandbox-1",
					}),
				);
				yield* db.insertDirectory(
					yield* ProjectDirectoryRow.insert.makeEffect({
						id: "directory-2",
						projectId: "project-1",
						directory: "/workspace/codework-feature",
						type: "gitworktree",
						sandboxEnvId: "sandbox-2",
					}),
				);

				const directories = yield* db.selectDirectories("project-1");
				expect(
					directories.map((row) => ({
						id: row.id,
						directory: row.directory,
						type: row.type,
						sandboxEnvId: row.sandboxEnvId,
					})),
				).toEqual([
					{
						id: "directory-1",
						directory: "/workspace/codework",
						type: "main",
						sandboxEnvId: "sandbox-1",
					},
					{
						id: "directory-2",
						directory: "/workspace/codework-feature",
						type: "gitworktree",
						sandboxEnvId: "sandbox-2",
					},
				]);
			}),
		);

		it(
			"enforces foreign keys and unique project directories",
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const db = queries(sql);

				const orphan = yield* ProjectDirectoryRow.insert.makeEffect({
					id: "orphan",
					projectId: "missing-project",
					directory: "/workspace/orphan",
					type: "root",
					sandboxEnvId: "sandbox-orphan",
				});
				const orphanExit = yield* db.insertDirectory(orphan).pipe(Effect.exit);
				expect(orphanExit._tag).toBe("Failure");

				yield* db.insertProject(yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "codework" }));
				yield* db.insertDirectory(
					yield* ProjectDirectoryRow.insert.makeEffect({
						id: "directory-1",
						projectId: "project-1",
						directory: "/workspace/codework",
						type: "main",
						sandboxEnvId: "sandbox-1",
					}),
				);

				const duplicate = yield* ProjectDirectoryRow.insert.makeEffect({
					id: "directory-2",
					projectId: "project-1",
					directory: "/workspace/codework",
					type: "root",
					sandboxEnvId: "sandbox-2",
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

				yield* db.insertProject(yield* ProjectRow.insert.makeEffect({ id: "project-1", name: "codework" }));
				yield* db.insertDirectory(
					yield* ProjectDirectoryRow.insert.makeEffect({
						id: "directory-1",
						projectId: "project-1",
						directory: "/workspace/codework",
						type: "main",
						sandboxEnvId: "sandbox-1",
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
