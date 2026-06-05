import { NodeFileSystem } from "@effect/platform-node";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Effect, FileSystem, Layer } from "effect";
import path from "node:path";
import { describe, expect } from "vite-plus/test";
import { Database } from "../../src/db/db";
import { testEffect } from "../utils/effect";

const DemoTable = sqliteTable("demo", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
});

const schema = {
	DemoTable,
};

const layer = Layer.unwrap(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const dir = yield* fs.makeTempDirectoryScoped();
		return Database.layerFromPath(path.join(dir, "test.db"), { schema });
	}),
).pipe(Layer.provide(NodeFileSystem.layer));

const { effect: it } = testEffect(layer);

describe("Database", () => {
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
