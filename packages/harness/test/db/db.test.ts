import { NodeFileSystem } from "@effect/platform-node";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Effect, FileSystem, Layer, Schema } from "effect";
import path from "node:path";
import { describe, expect } from "vite-plus/test";
import { Database } from "../../src/db/db";
import {
	Project,
	ProjectDirectoryInsert,
	ProjectDirectoryTable,
	ProjectInsert,
	ProjectTable,
} from "../../src/db/schema.sql";
import { testEffect } from "../utils/effect";

const DemoTable = sqliteTable("demo", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
});

const schema = {
	DemoTable,
	ProjectTable,
	ProjectDirectoryTable,
};

const migrationsFolder = path.join(import.meta.dirname, "../../migrations");

const layer = Layer.unwrap(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const dir = yield* fs.makeTempDirectoryScoped();
		return Database.layerFromPath(path.join(dir, "test.db"), {
			schema,
			migrate: (db) =>
				Effect.tryPromise({
					try: () => migrate(db, { migrationsFolder }),
					catch: (cause) => new Database.DatabaseError({ method: "migrate", cause }),
				}).pipe(Effect.asVoid),
		});
	}),
).pipe(Layer.provide(NodeFileSystem.layer));

const { effect: it } = testEffect(layer);

describe("Database", () => {
	describe("Effect wrapper", () => {
		it(
			"provides an Effect Drizzle database",
			Effect.gen(function* () {
				const { db } = yield* Database.Service;

				yield* db.run("CREATE TABLE demo (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)");
				yield* db
					.insert(DemoTable)
					.values([{ name: "beta" }, { name: "alpha" }])
					.run();

				const rows = yield* db
					.select({ name: DemoTable.name })
					.from(DemoTable)
					.where(eq(DemoTable.name, "alpha"))
					.all();

				expect(rows).toEqual([{ name: "alpha" }]);
			}),
		);
	});

	describe("Project tables", () => {
		it(
			"inserts and reads a project with its directories",
			Effect.gen(function* () {
				const { db } = yield* Database.Service;

				const project = yield* Schema.decodeUnknownEffect(ProjectInsert)({
					id: "project-1",
					name: "codework",
					vcs: "git",
				});
				const mainDirectory = yield* Schema.decodeUnknownEffect(ProjectDirectoryInsert)({
					id: "directory-1",
					projectId: project.id,
					directory: "/workspace/codework",
					type: "main",
					sandboxEnvID: "sandbox-1",
				});
				const worktreeDirectory = yield* Schema.decodeUnknownEffect(ProjectDirectoryInsert)({
					id: "directory-2",
					projectId: project.id,
					directory: "/workspace/codework-feature",
					type: "gitworktree",
					sandboxEnvID: "sandbox-2",
				});

				yield* db.insert(ProjectTable).values(project).run();
				yield* db.insert(ProjectDirectoryTable).values([mainDirectory, worktreeDirectory]).run();

				const projectRows = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, project.id)).all();
				const directoryRows = yield* db
					.select({
						id: ProjectDirectoryTable.id,
						directory: ProjectDirectoryTable.directory,
						type: ProjectDirectoryTable.type,
						sandboxEnvID: ProjectDirectoryTable.sandboxEnvID,
					})
					.from(ProjectDirectoryTable)
					.where(eq(ProjectDirectoryTable.projectId, project.id))
					.orderBy(ProjectDirectoryTable.id)
					.all();

				const result = yield* Schema.decodeUnknownEffect(Project)({
					...projectRows[0],
					directories: directoryRows,
				});

				expect(result).toEqual({
					id: "project-1",
					name: "codework",
					vcs: "git",
					createdAt: expect.any(Number),
					updatedAt: expect.any(Number),
					directories: [
						{
							id: "directory-1",
							directory: "/workspace/codework",
							type: "main",
							sandboxEnvID: "sandbox-1",
						},
						{
							id: "directory-2",
							directory: "/workspace/codework-feature",
							type: "gitworktree",
							sandboxEnvID: "sandbox-2",
						},
					],
				});
			}),
		);

		it(
			"enforces foreign keys and unique project directories",
			Effect.gen(function* () {
				const { db } = yield* Database.Service;

				const orphanExit = yield* db
					.insert(ProjectDirectoryTable)
					.values({
						id: "orphan",
						projectId: "missing-project",
						directory: "/workspace/orphan",
						type: "root",
						sandboxEnvID: "sandbox-orphan",
					})
					.run()
					.pipe(Effect.exit);

				expect(orphanExit._tag).toBe("Failure");

				yield* db.insert(ProjectTable).values({ id: "project-1", name: "codework", vcs: "git" }).run();
				yield* db
					.insert(ProjectDirectoryTable)
					.values({
						id: "directory-1",
						projectId: "project-1",
						directory: "/workspace/codework",
						type: "main",
						sandboxEnvID: "sandbox-1",
					})
					.run();

				const duplicateExit = yield* db
					.insert(ProjectDirectoryTable)
					.values({
						id: "directory-2",
						projectId: "project-1",
						directory: "/workspace/codework",
						type: "root",
						sandboxEnvID: "sandbox-2",
					})
					.run()
					.pipe(Effect.exit);

				expect(duplicateExit._tag).toBe("Failure");
			}),
		);

		it(
			"deletes project directories when their project is deleted",
			Effect.gen(function* () {
				const { db } = yield* Database.Service;

				yield* db.insert(ProjectTable).values({ id: "project-1", name: "codework", vcs: "git" }).run();
				yield* db
					.insert(ProjectDirectoryTable)
					.values({
						id: "directory-1",
						projectId: "project-1",
						directory: "/workspace/codework",
						type: "main",
						sandboxEnvID: "sandbox-1",
					})
					.run();

				yield* db.delete(ProjectTable).where(eq(ProjectTable.id, "project-1")).run();

				const directories = yield* db
					.select()
					.from(ProjectDirectoryTable)
					.where(eq(ProjectDirectoryTable.projectId, "project-1"))
					.all();

				expect(directories).toEqual([]);
			}),
		);
	});
});
