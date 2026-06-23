import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { RemoteFileSystem } from "../src/sandbox/filesystem/remote";

const enoent = (path: string) => {
	const error = new Error(`ENOENT: no such file or directory, '${path}'`) as NodeJS.ErrnoException;
	error.code = "ENOENT";
	return error;
};

const makeProvider = () => {
	const files = new Map<string, Buffer>();
	const directories = new Set(["/"]);

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
		const content = files.get(target);
		if (content !== undefined) return { size: content.byteLength, isFile: true, isDirectory: false };
		throw enoent(target);
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

	it("passes relative paths through when no cwd is configured", async () => {
		const remote = makeProvider();
		const filesystem = RemoteFileSystem.make(remote.provider);

		await filesystem.writeFile("src/index.ts", "data");

		expect(remote.files.has("src/index.ts")).toBe(true);
		expect(remote.files.has(posix.join(process.cwd(), "src/index.ts"))).toBe(false);
	});

	it("removes files and directories through the provider", async () => {
		const remote = makeProvider();
		const filesystem = RemoteFileSystem.make(remote.provider);

		await filesystem.writeFile("dir/file.txt", "data");
		await filesystem.rm("dir", { recursive: true });

		expect(await filesystem.exists("dir/file.txt")).toBe(false);
		expect(await filesystem.exists("dir")).toBe(false);
		await expect(filesystem.rm("missing", { force: true })).resolves.toBeUndefined();
	});
});
