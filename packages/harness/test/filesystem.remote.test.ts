import { Effect } from "effect";
import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../src/sandbox/fs/filesystem.ts";
import { RemoteFileSystem } from "../src/sandbox/fs/remote.ts";

const enoent = (path: string) => {
	const error = new Error(`ENOENT: no such file or directory, '${path}'`) as NodeJS.ErrnoException;
	error.code = "ENOENT";
	return error;
};

const makeProvider = () => {
	const files = new Map<string, Buffer>();
	const directories = new Set(["/"]);
	const symlinks = new Set<string>();

	const normalize = (path: string) => posix.normalize(path);
	const mkdirp = (path: string) => {
		let current = posix.isAbsolute(path) ? "/" : "";
		for (const part of normalize(path).split("/").filter(Boolean)) {
			current = current === "" || current === "/" ? `${current}${part}` : `${current}/${part}`;
			directories.add(current);
		}
	};

	const stat = async (path: string): Promise<RemoteFileSystem.FileStat> => {
		const target = normalize(path);
		if (directories.has(target)) return { isFile: false, isDirectory: true };
		if (symlinks.has(target)) return { isFile: true, isDirectory: false, isSymbolicLink: false };
		const content = files.get(target);
		if (content !== undefined) return { size: content.byteLength, isFile: true, isDirectory: false };
		throw enoent(target);
	};

	const lstat = async (path: string): Promise<RemoteFileSystem.FileStat> => {
		const target = normalize(path);
		if (symlinks.has(target)) return { isFile: false, isDirectory: false, isSymbolicLink: true };
		return stat(target);
	};

	const readdir = async (path: string) => {
		const target = normalize(path);
		if (!directories.has(target)) throw enoent(target);
		const prefix = target === "/" ? "/" : `${target}/`;
		const entries = new Set<string>();
		for (const dir of directories) {
			if (dir !== target && dir.startsWith(prefix)) entries.add(dir.slice(prefix.length).split("/")[0]!);
		}
		for (const file of files.keys()) {
			if (file.startsWith(prefix)) entries.add(file.slice(prefix.length).split("/")[0]!);
		}
		return [...entries].sort();
	};

	const rm = async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
		const target = normalize(path);
		if (files.delete(target)) return;
		if (!directories.has(target)) {
			if (options?.force) return;
			throw enoent(target);
		}
		if (!options?.recursive && (await readdir(target)).length > 0) throw new Error(`ENOTEMPTY: '${target}'`);
		for (const file of files.keys()) {
			if (file.startsWith(`${target}/`)) files.delete(file);
		}
		for (const dir of [...directories].sort((a, b) => b.length - a.length)) {
			if (dir !== "/" && (dir === target || dir.startsWith(`${target}/`))) directories.delete(dir);
		}
	};

	return {
		files,
		directories,
		symlinks,
		provider: {
			readFile: async (path: string) =>
				Buffer.from(await stat(path).then(() => files.get(normalize(path))!)).toString("utf8"),
			readFileBuffer: async (path: string) =>
				new Uint8Array(await stat(path).then(() => files.get(normalize(path))!)),
			writeFile: async (path: string, content: string | Uint8Array) => {
				const target = normalize(path);
				if (!directories.has(posix.dirname(target))) throw enoent(posix.dirname(target));
				files.set(target, typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content));
			},
			stat,
			lstat,
			readdir,
			exists: async (path: string) => {
				try {
					await stat(path);
					return true;
				} catch {
					return false;
				}
			},
			mkdir: async (path: string, options?: { recursive?: boolean }) => {
				const target = normalize(path);
				if (!options?.recursive && directories.has(target)) {
					throw new Error(`EEXIST: file already exists, mkdir '${target}'`);
				}
				mkdirp(target);
			},
			rm,
		},
	};
};

describe("RemoteFileSystem", () => {
	it("resolves relative paths against a remote cwd", async () => {
		const remote = makeProvider();
		remote.directories.add("/workspace");
		// This wrapper resolves paths and nothing else — parent creation belongs to
		// `fromProvider` (asserted below), so the target directory exists up front.
		remote.directories.add("/workspace/src");
		const filesystem = RemoteFileSystem.make(remote.provider, { cwd: "/workspace" });

		await filesystem.writeFile("src/index.ts", "export const value = 1;\n");

		expect(await filesystem.readFile("src/index.ts")).toBe("export const value = 1;\n");
		expect(await filesystem.readFileBuffer("src/index.ts")).toBeInstanceOf(Uint8Array);
		expect(await filesystem.exists("src/index.ts")).toBe(true);
		expect(await filesystem.exists("/workspace/src/index.ts")).toBe(true);
		expect(await filesystem.exists("/src/index.ts")).toBe(false);
		expect((await filesystem.stat("src")).isDirectory).toBe(true);
		expect((await filesystem.stat("src/index.ts")).isFile).toBe(true);
		expect(await filesystem.readdir("src")).toEqual(["index.ts"]);
		expect(remote.files.has("/workspace/src/index.ts")).toBe(true);
	});

	it("resolves explicit remote lstat paths against cwd when the provider supports it", async () => {
		const remote = makeProvider();
		remote.directories.add("/workspace");
		remote.symlinks.add("/workspace/link.txt");
		const filesystem = RemoteFileSystem.make(remote.provider, { cwd: "/workspace" });

		expect(filesystem.lstat).toBeDefined();
		const stat = await filesystem.stat("link.txt");
		const lstat = await filesystem.lstat!("link.txt");

		expect(stat.isSymbolicLink).toBe(false);
		expect(lstat.isSymbolicLink).toBe(true);
	});

	it("passes relative paths through when no cwd is configured", async () => {
		const remote = makeProvider();
		remote.directories.add("src");
		const filesystem = RemoteFileSystem.make(remote.provider);

		await filesystem.writeFile("src/index.ts", "data");

		expect(remote.files.has("src/index.ts")).toBe(true);
		expect(remote.files.has(posix.join(process.cwd(), "src/index.ts"))).toBe(false);
	});

	it("removes files and directories through the provider", async () => {
		const remote = makeProvider();
		remote.directories.add("dir");
		const filesystem = RemoteFileSystem.make(remote.provider);

		await filesystem.writeFile("dir/file.txt", "data");
		await filesystem.rm("dir", { recursive: true });

		expect(await filesystem.exists("dir/file.txt")).toBe(false);
		expect(await filesystem.exists("dir")).toBe(false);
		await expect(filesystem.rm("missing", { force: true })).resolves.toBeUndefined();
	});

	// Parent creation is the runtime's guarantee and lives one layer up, so it is
	// asserted over the composition every remote provider actually builds rather
	// than over the resolver alone.
	it("creates missing parents on write, composed with fromProvider", async () => {
		const remote = makeProvider();
		remote.directories.add("/workspace");
		const filesystem = SandboxFileSystem.fromProvider(RemoteFileSystem.make(remote.provider, { cwd: "/workspace" }));

		await Effect.runPromise(filesystem.writeFile("deeply/nested/file.txt", "data"));

		expect(remote.files.has("/workspace/deeply/nested/file.txt")).toBe(true);
		expect(remote.directories.has("/workspace/deeply/nested")).toBe(true);
	});

	// A write that fails for a reason mkdir cannot fix must surface its own error,
	// not the mkdir's — otherwise every permission fault reads as a path fault.
	it("reports the write's error, not the retry's, when parents are not the problem", async () => {
		const remote = makeProvider();
		remote.directories.add("/workspace");
		const provider = {
			...remote.provider,
			writeFile: async () => {
				const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			},
			mkdir: async () => {
				throw new Error("mkdir exploded");
			},
		};
		const filesystem = SandboxFileSystem.fromProvider(RemoteFileSystem.make(provider, { cwd: "/workspace" }));

		const error = await Effect.runPromise(Effect.flip(filesystem.writeFile("a/b.txt", "data")));

		expect(error.method).toBe("writeFile");
		expect((error.cause as NodeJS.ErrnoException).code).toBe("EACCES");
	});
});
