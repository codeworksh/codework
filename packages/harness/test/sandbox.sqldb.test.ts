import { Effect } from "effect";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Service } from "../src/filesystem/filesystem";
import { Sandbox } from "../src/sandbox/sandbox";
import { filesystemSpec } from "./fixtures/sandbox.spec";
import { tmpdir } from "./fixtures/tempdir";

describe("Sandbox.EnvSqldb", () => {
	describe("in-memory database", () => {
		filesystemSpec(async () => ({
			sandbox: Sandbox.EnvSqldb.layer(),
		}));
	});

	describe("file-backed database", () => {
		filesystemSpec(async () => {
			const tmp = await tmpdir();
			return {
				sandbox: Sandbox.EnvSqldb.layer(path.join(tmp.path, "fs.db")),
				dispose: () => tmp[Symbol.asyncDispose](),
			};
		});

		// the database file outlives the sandbox: a fresh layer build against
		// the same file sees everything written by the previous lifetime
		it("persists files across sandbox lifetimes", async () => {
			await using tmp = await tmpdir();
			const database = path.join(tmp.path, "fs.db");

			await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					yield* filesystem.writeFileString("/file.txt", "persisted");
				}).pipe(Effect.provide(Sandbox.filesystem(Sandbox.EnvSqldb.layer(database)))),
			);

			const content = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					return yield* filesystem.readFileString("/file.txt");
				}).pipe(Effect.provide(Sandbox.filesystem(Sandbox.EnvSqldb.layer(database)))),
			);

			expect(content).toBe("persisted");
		});
	});

	// each in-memory sandbox owns its own database: nothing leaks between
	// independent layer builds
	it("isolates separate in-memory sandboxes", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				yield* filesystem.writeFileString("/file.txt", "first");
			}).pipe(Effect.provide(Sandbox.filesystem(Sandbox.EnvSqldb.layer()))),
		);

		const exists = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				return yield* filesystem.exists("/file.txt");
			}).pipe(Effect.provide(Sandbox.filesystem(Sandbox.EnvSqldb.layer()))),
		);

		expect(exists).toBe(false);
	});
});
