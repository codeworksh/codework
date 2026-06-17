import { Effect, Layer } from "effect";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../../src/sandbox/filesystem/filesystem";
import { Virtual } from "../../src/sandbox/filesystem/virtual";
import type { Sandbox } from "../../src/sandbox/sandbox";

export interface SandboxEnv {
	readonly sandbox: Sandbox.Sandbox;
	readonly dispose?: () => Promise<void>;
}

export type MakeSandbox = () => Promise<SandboxEnv>;

/**
 * Build the sandbox, hand the live `SandboxFileSystem.Service` to a plain async
 * body, and dispose afterwards. The service surface is Promise-based, so tests
 * read like ordinary `async`/`await` against `fs`.
 */
export const withService = async <A>(
	make: MakeSandbox,
	body: (fs: SandboxFileSystem.Interface) => Promise<A>,
): Promise<A> => {
	const env = await make();
	try {
		return await Effect.runPromise(
			Effect.gen(function* () {
				const fs = yield* SandboxFileSystem.Service;
				return yield* Effect.promise(() => body(fs));
			}).pipe(Effect.scoped, Effect.provide(Layer.provideMerge(Virtual.layer, env.sandbox))),
		);
	} finally {
		await env.dispose?.();
	}
};

/**
 * Behavioral spec every local sandbox filesystem must satisfy, covering the
 * full `SandboxFileSystem` surface — success and failure paths of every method.
 * Each test builds a fresh sandbox via `make` and consumes the service exactly
 * as the runtime does.
 */
export const filesystemSpec = (make: MakeSandbox) => {
	const run = <A>(body: (fs: SandboxFileSystem.Interface) => Promise<A>) => withService(make, body);

	describe("readFile / writeFile", () => {
		it("round-trips utf-8 content", async () => {
			await run(async (fs) => {
				await fs.writeFile("/file.txt", "héllo\nwörld\n🚀");
				expect(await fs.readFile("/file.txt")).toBe("héllo\nwörld\n🚀");
			});
		});

		it("overwrites existing content", async () => {
			await run(async (fs) => {
				await fs.writeFile("/file.txt", "first");
				await fs.writeFile("/file.txt", "second");
				expect(await fs.readFile("/file.txt")).toBe("second");
			});
		});

		it("creates missing parent directories on write", async () => {
			await run(async (fs) => {
				await fs.writeFile("/deeply/nested/dir/file.txt", "data");
				expect(await fs.readFile("/deeply/nested/dir/file.txt")).toBe("data");
				expect((await fs.stat("/deeply/nested/dir")).isDirectory).toBe(true);
			});
		});

		it("rejects reading a missing file", async () => {
			await run(async (fs) => {
				await expect(fs.readFile("/missing.txt")).rejects.toBeDefined();
			});
		});

		it("rejects reading a directory", async () => {
			await run(async (fs) => {
				await fs.mkdir("/dir", { recursive: true });
				await expect(fs.readFile("/dir")).rejects.toBeDefined();
			});
		});
	});

	describe("readFileBuffer", () => {
		it("round-trips raw bytes as a Uint8Array", async () => {
			await run(async (fs) => {
				const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
				await fs.writeFile("/binary.dat", bytes);

				const read = await fs.readFileBuffer("/binary.dat");
				expect(read).toBeInstanceOf(Uint8Array);
				expect(Buffer.from(read).equals(Buffer.from(bytes))).toBe(true);
			});
		});
	});

	describe("stat", () => {
		it("identifies files and directories", async () => {
			await run(async (fs) => {
				await fs.writeFile("/file.txt", "data");
				await fs.mkdir("/dir", { recursive: true });

				const file = await fs.stat("/file.txt");
				expect(file.isFile).toBe(true);
				expect(file.isDirectory).toBe(false);
				expect(file.size).toBe(4);

				const dir = await fs.stat("/dir");
				expect(dir.isDirectory).toBe(true);
				expect(dir.isFile).toBe(false);
			});
		});

		it("rejects a missing path", async () => {
			await run(async (fs) => {
				await expect(fs.stat("/missing")).rejects.toBeDefined();
			});
		});
	});

	describe("readdir", () => {
		it("lists entry names, not paths", async () => {
			await run(async (fs) => {
				await fs.writeFile("/dir/a.txt", "a");
				await fs.writeFile("/dir/b.txt", "b");
				await fs.mkdir("/dir/sub", { recursive: true });

				expect((await fs.readdir("/dir")).sort()).toEqual(["a.txt", "b.txt", "sub"]);
			});
		});

		it("rejects a missing directory", async () => {
			await run(async (fs) => {
				await expect(fs.readdir("/missing")).rejects.toBeDefined();
			});
		});
	});

	describe("exists", () => {
		it("reports files, directories, and the root", async () => {
			await run(async (fs) => {
				await fs.writeFile("/file.txt", "data");
				expect(await fs.exists("/")).toBe(true);
				expect(await fs.exists("/file.txt")).toBe(true);
			});
		});

		it("returns false for missing paths instead of throwing", async () => {
			await run(async (fs) => {
				expect(await fs.exists("/missing.txt")).toBe(false);
				expect(await fs.exists("/missing/deeply/nested")).toBe(false);
			});
		});
	});

	describe("mkdir", () => {
		it("creates a directory", async () => {
			await run(async (fs) => {
				await fs.mkdir("/dir", { recursive: true });
				expect((await fs.stat("/dir")).isDirectory).toBe(true);
			});
		});

		it("creates parents when recursive", async () => {
			await run(async (fs) => {
				await fs.mkdir("/a/b/c", { recursive: true });
				expect((await fs.stat("/a/b/c")).isDirectory).toBe(true);
			});
		});

		it("rejects a missing parent when not recursive", async () => {
			await run(async (fs) => {
				await expect(fs.mkdir("/a/b/c")).rejects.toBeDefined();
			});
		});
	});

	describe("rm", () => {
		it("removes a file", async () => {
			await run(async (fs) => {
				await fs.writeFile("/file.txt", "data");
				await fs.rm("/file.txt");
				expect(await fs.exists("/file.txt")).toBe(false);
			});
		});

		it("removes a directory tree recursively", async () => {
			await run(async (fs) => {
				await fs.writeFile("/dir/nested/file.txt", "data");
				await fs.rm("/dir", { recursive: true });
				expect(await fs.exists("/dir")).toBe(false);
			});
		});

		it("rejects removing a non-empty directory without recursive", async () => {
			await run(async (fs) => {
				await fs.writeFile("/dir/file.txt", "data");
				await expect(fs.rm("/dir")).rejects.toBeDefined();
			});
		});

		it("rejects a missing path, but pardons it under force", async () => {
			await run(async (fs) => {
				await expect(fs.rm("/missing.txt")).rejects.toBeDefined();
				await expect(fs.rm("/missing.txt", { force: true })).resolves.toBeUndefined();
			});
		});
	});
};
