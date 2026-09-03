import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../src/sandbox/fs/filesystem.ts";

describe("SandboxFileSystem.fromProvider", () => {
	it("preserves the write error when creating parents cannot repair it", async () => {
		const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		let writes = 0;
		let mkdirs = 0;
		const provider: SandboxFileSystem.Provider = {
			readFile: async () => "",
			readFileBuffer: async () => new Uint8Array(),
			writeFile: async () => {
				writes += 1;
				throw denied;
			},
			stat: async () => ({ isFile: false, isDirectory: false }),
			readdir: async () => [],
			exists: async () => false,
			mkdir: async () => {
				mkdirs += 1;
				throw new Error("mkdir exploded");
			},
			rm: async () => undefined,
		};
		const filesystem = SandboxFileSystem.fromProvider(provider);

		const error = await Effect.runPromise(Effect.flip(filesystem.writeFile("a/b.txt", "data")));

		expect(error.method).toBe("writeFile");
		expect(error.cause).toBe(denied);
		expect(writes).toBe(2);
		expect(mkdirs).toBe(1);
	});
});
