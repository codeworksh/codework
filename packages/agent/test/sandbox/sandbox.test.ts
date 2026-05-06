import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	createInMemoryEphemeralEnv,
	createLocalEnv,
	createLocalNodeEnv,
	createLocalNodeFactory,
	LocalNodeEnv,
} from "../../src/sandbox/builtin.ts";
import { Sandbox } from "../../src/sandbox/sandbox.ts";

const tempDirectories = new Set<string>();

async function createTempDirectory(name: string) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), `codework-sandbox-${name}-`));
	tempDirectories.add(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		[...tempDirectories].map(async (directory) => {
			await fs.rm(directory, { force: true, recursive: true });
			tempDirectories.delete(directory);
		}),
	);
});

describe("built-in sandbox environments", () => {
	// Local just-bash sandbox backed by the host directory.
	it("creates a local sandbox backed by the provided directory", async () => {
		const directory = await createTempDirectory("local");
		const sandbox = await createLocalEnv(directory);

		expect(sandbox.id).toBe(directory);
		expect(sandbox.cwd).toBe(directory);

		await sandbox.writeFile("nested/file.txt", "hello from sandbox");

		await expect(fs.readFile(path.join(directory, "nested/file.txt"), "utf8")).resolves.toBe("hello from sandbox");
		await expect(sandbox.readFile("nested/file.txt")).resolves.toBe("hello from sandbox");
		await expect(sandbox.exists("nested/file.txt")).resolves.toBe(true);
	});

	// Default isolated in-memory sandbox.
	it("creates an ephemeral in-memory sandbox", async () => {
		const sandbox = await createInMemoryEphemeralEnv();

		expect(sandbox.id).toEqual(expect.any(String));
		expect(sandbox.ephemeral).toBe(true);

		await sandbox.writeFile("notes.txt", "in memory");

		await expect(sandbox.readFile("notes.txt")).resolves.toBe("in memory");
		await expect(sandbox.exists("notes.txt")).resolves.toBe(true);
	});

	// Local node sandbox backed by direct node filesystem and child process APIs.
	it("creates a local node sandbox backed by the provided directory", async () => {
		const directory = await createTempDirectory("local-node");
		const sandbox = await createLocalNodeEnv(directory);

		expect(sandbox.id).toBe(directory);
		expect(sandbox.cwd).toBe(directory);

		await sandbox.writeFile("nested/file.txt", "hello from node sandbox");
		const result = await sandbox.exec("pwd && cat nested/file.txt");
		const realDirectory = await fs.realpath(directory);

		expect(result.code).toBe(0);
		expect(result.stdout.toString()).toBe(`${realDirectory}\nhello from node sandbox`);
		await expect(fs.readFile(path.join(directory, "nested/file.txt"), "utf8")).resolves.toBe(
			"hello from node sandbox",
		);
	});

	// Shared adapter that wraps any Sandbox.API implementation into Sandbox.Env.
	it("wraps a sandbox api into a session env", async () => {
		const directory = await createTempDirectory("session-env");
		let cleaned = false;
		const sandbox = Sandbox.createSandboxSessionEnv(new LocalNodeEnv(directory), directory, async () => {
			cleaned = true;
		});

		expect(sandbox.id).toBe(directory);
		expect(sandbox.cwd).toBe(directory);
		expect(sandbox.resolvePath("nested/file.txt")).toBe(`${directory}/nested/file.txt`);

		await sandbox.writeFile("nested/file.txt", "session env");
		await expect(sandbox.readFile("/nested/file.txt")).rejects.toThrow("Path escapes sandbox root");
		await expect(fs.readFile(path.join(directory, "nested/file.txt"), "utf8")).resolves.toBe("session env");

		await sandbox.cleanup();

		expect(cleaned).toBe(true);
	});

	// Local node sandbox path containment checks.
	it("prevents local node sandbox file access outside the root", async () => {
		const directory = await createTempDirectory("local-node-escape");
		const sandbox = await createLocalNodeEnv(directory);

		await expect(sandbox.readFile(path.dirname(directory))).rejects.toThrow("Path escapes sandbox root");
		await expect(sandbox.exec("pwd", { cwd: path.dirname(directory) })).rejects.toThrow("Path escapes sandbox root");
	});

	// Common Sandbox.Factory entry point for future sandbox implementations.
	it("creates local node sandboxes through the common factory interface", async () => {
		const directory = await createTempDirectory("local-node-factory");
		const factory = createLocalNodeFactory();
		const sandbox = await factory.createSandboxEnv({ id: "local-node", cwd: directory });

		expect(sandbox.id).toBe(directory);
		expect(sandbox.cwd).toBe(directory);

		await sandbox.writeFile("factory.txt", "factory sandbox");

		await expect(fs.readFile(path.join(directory, "factory.txt"), "utf8")).resolves.toBe("factory sandbox");
	});

	// Scoped environments should keep access to the parent sandbox filesystem state.
	it("shares filesystem state with scoped sandbox environments", async () => {
		const sandbox = await createInMemoryEphemeralEnv();
		const scoped = await sandbox.scope?.();

		expect(scoped).toBeDefined();

		await scoped!.writeFile("shared.txt", "shared state");

		await expect(sandbox.readFile("shared.txt")).resolves.toBe("shared state");
	});
});
