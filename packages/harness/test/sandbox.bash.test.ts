import { Effect } from "effect";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Service } from "../src/filesystem/filesystem";
import { EnvBash } from "../src/sandbox/bash";
import { Sandbox } from "../src/sandbox/sandbox";
import { filesystemSpec } from "./fixtures/sandbox.spec";
import { tmpdir } from "./fixtures/tempdir";

describe("Sandbox.EnvBash", () => {
	// wrapping a sandbox must not change its filesystem semantics
	filesystemSpec(async () => ({
		sandbox: Sandbox.EnvBash.layer(Sandbox.EnvInMemory.layer()),
	}));

	describe("shell and FileSystem.Service share one filesystem", () => {
		const sandbox = () => Sandbox.EnvBash.services(Sandbox.EnvInMemory.layer());

		it("shell reads what the service wrote", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					const shell = yield* EnvBash.Shell;

					yield* filesystem.writeFileString("/file.txt", "from service");

					return yield* shell.exec("cat /file.txt");
				}).pipe(Effect.provide(sandbox())),
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("from service");
		});

		it("service reads what the shell wrote", async () => {
			const content = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					const shell = yield* EnvBash.Shell;

					const result = yield* shell.exec('mkdir -p /workspace && echo "from shell" > /workspace/file.txt');
					expect(result.exitCode).toBe(0);

					return yield* filesystem.readFileString("/workspace/file.txt");
				}).pipe(Effect.provide(sandbox())),
			);

			expect(content).toBe("from shell\n");
		});

		it("runs pipelines over service-written files", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const filesystem = yield* Service;
					const shell = yield* EnvBash.Shell;

					yield* filesystem.writeFileString("/data.txt", "alpha\nbeta\ngamma\nbeta\n");

					return yield* shell.exec("cat /data.txt | grep beta | wc -l");
				}).pipe(Effect.provide(sandbox())),
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("2");
		});

		it("reports failures through exit codes", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const shell = yield* EnvBash.Shell;
					return yield* shell.exec("cat /missing.txt");
				}).pipe(Effect.provide(sandbox())),
			);

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("missing.txt");
		});
	});

	// the wrapper composes with any vfs backend: shell writes through to a
	// sqlite-backed filesystem and survive sandbox lifetimes
	it("works over the sqldb backend with persistence", async () => {
		await using tmp = await tmpdir();
		const database = path.join(tmp.path, "fs.db");

		await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* EnvBash.Shell;
				const result = yield* shell.exec('echo "persisted by bash" > /file.txt');
				expect(result.exitCode).toBe(0);
			}).pipe(Effect.provide(Sandbox.EnvBash.services(Sandbox.EnvSqldb.layer(database)))),
		);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* EnvBash.Shell;
				return yield* shell.exec("cat /file.txt");
			}).pipe(Effect.provide(Sandbox.EnvBash.services(Sandbox.EnvSqldb.layer(database)))),
		);

		expect(result.stdout).toBe("persisted by bash\n");
	});

	// and over the default backend: bash output lands on the real disk
	it("works over the default backend", async () => {
		await using tmp = await tmpdir();

		const content = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				const shell = yield* EnvBash.Shell;

				const result = yield* shell.exec('echo "real disk" > /file.txt');
				expect(result.exitCode).toBe(0);

				return yield* filesystem.readFileString("/file.txt");
			}).pipe(Effect.provide(Sandbox.EnvBash.services(Sandbox.EnvDefault.layer(tmp.path)))),
		);

		expect(content).toBe("real disk\n");
	});
});
