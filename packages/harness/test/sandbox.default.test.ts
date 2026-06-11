import { Effect } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Service } from "../src/filesystem/filesystem";
import { Sandbox } from "../src/sandbox/sandbox";
import { filesystemSpec } from "./fixtures/sandbox.spec";
import { tmpdir } from "./fixtures/tempdir";

describe("Sandbox.EnvDefault", () => {
	filesystemSpec(async () => {
		const tmp = await tmpdir();
		return {
			sandbox: Sandbox.EnvDefault.layer(tmp.path),
			dispose: () => tmp[Symbol.asyncDispose](),
		};
	});

	// EnvDefault is rooted at a host directory: writes through the sandbox
	// must land on the real filesystem, and vice versa.
	it("writes through to the real filesystem under the configured root", async () => {
		await using tmp = await tmpdir();

		await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				yield* filesystem.writeFileString("/file.txt", "hello");
			}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvDefault.layer(tmp.path)))),
		);

		expect(await fs.readFile(path.join(tmp.path, "file.txt"), "utf8")).toBe("hello");
	});

	it("sees files created on the real filesystem", async () => {
		await using tmp = await tmpdir();
		await fs.writeFile(path.join(tmp.path, "host.txt"), "from host");

		const content = await Effect.runPromise(
			Effect.gen(function* () {
				const filesystem = yield* Service;
				return yield* filesystem.readFileString("/host.txt");
			}).pipe(Effect.provide(Sandbox.services(Sandbox.EnvDefault.layer(tmp.path)))),
		);

		expect(content).toBe("from host");
	});
});
