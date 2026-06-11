import { Effect } from "effect";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Service } from "../src/filesystem/filesystem";
import { Sandbox } from "../src/sandbox/sandbox";
import { tmpdir } from "./fixtures/tempdir";

describe("Sandbox.EnvSqldb", () => {
	it("provides a filesystem backed by an in-memory sqlite database", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;

				yield* filesystem.writeFileString("/file.txt", "hello");
				expect(yield* filesystem.readFileString("/file.txt")).toBe("hello");

				expect(yield* filesystem.exists("/file.txt")).toBe(true);
				expect(yield* filesystem.exists("/missing.txt")).toBe(false);
				expect(yield* filesystem.isDir("/file.txt")).toBe(false);
			}).pipe(Effect.provide(Sandbox.filesystem(Sandbox.EnvSqldb.layer()))),
		);
	});

	it("walks up directories stored in sqlite", async () => {
		const matches = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;

				yield* filesystem.writeFileString("/package.json", "{}");

				return yield* filesystem.up({ targets: ["package.json"], start: "/" });
			}).pipe(Effect.provide(Sandbox.filesystem(Sandbox.EnvSqldb.layer()))),
		);

		expect(matches).toEqual(["/package.json"]);
	});

	it("persists files across sandbox lifetimes when backed by a database file", async () => {
		await using tmp = await tmpdir();
		const database = path.join(tmp.path, "fs.db");

		await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				yield* filesystem.writeFileString("/file.txt", "persisted");
			}).pipe(Effect.provide(Sandbox.filesystem(Sandbox.EnvSqldb.layer(database)))),
		);

		// a fresh layer build reopens the same database file
		const content = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				return yield* filesystem.readFileString("/file.txt");
			}).pipe(Effect.provide(Sandbox.filesystem(Sandbox.EnvSqldb.layer(database)))),
		);

		expect(content).toBe("persisted");
	});
});
