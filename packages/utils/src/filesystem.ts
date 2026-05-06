import { createWriteStream, existsSync, realpathSync, statSync } from "fs";
import { chmod, mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, relative, resolve as pathResolve } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

export namespace Filesystem {
	export async function exists(path: string): Promise<boolean> {
		return existsSync(path);
	}

	export async function isDir(path: string): Promise<boolean> {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	}

	export function stat(path: string): ReturnType<typeof statSync> | undefined {
		return statSync(path, { throwIfNoEntry: false }) ?? undefined;
	}

	export async function size(path: string): Promise<number> {
		const result = stat(path)?.size ?? 0;
		return typeof result === "bigint" ? Number(result) : result;
	}

	export async function readText(path: string): Promise<string> {
		return readFile(path, "utf-8");
	}

	export async function readJson<T = unknown>(path: string): Promise<T> {
		return JSON.parse(await readFile(path, "utf-8"));
	}

	export async function readBytes(path: string): Promise<Buffer> {
		return readFile(path);
	}

	export async function readArrayBuffer(path: string): Promise<ArrayBuffer> {
		const buffer = await readFile(path);
		return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
	}

	function isEnoent(error: unknown): error is { code: "ENOENT" } {
		return (
			typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT"
		);
	}

	export async function write(path: string, content: string | Buffer | Uint8Array, mode?: number): Promise<void> {
		try {
			if (mode) {
				await writeFile(path, content, { mode });
			} else {
				await writeFile(path, content);
			}
		} catch (error) {
			if (isEnoent(error)) {
				await mkdir(dirname(path), { recursive: true });
				if (mode) {
					await writeFile(path, content, { mode });
				} else {
					await writeFile(path, content);
				}
				return;
			}
			throw error;
		}
	}

	export async function writeJson(path: string, data: unknown, mode?: number): Promise<void> {
		return write(path, JSON.stringify(data, null, 2), mode);
	}

	export async function writeStream(
		path: string,
		stream: ReadableStream<Uint8Array> | Readable,
		mode?: number,
	): Promise<void> {
		const directory = dirname(path);
		if (!existsSync(directory)) {
			await mkdir(directory, { recursive: true });
		}

		const nodeStream = stream instanceof ReadableStream ? Readable.fromWeb(stream as never) : stream;
		const output = createWriteStream(path);
		await pipeline(nodeStream, output);

		if (mode) {
			await chmod(path, mode);
		}
	}

	export function normalizePath(path: string): string {
		if (process.platform !== "win32") return path;
		try {
			return realpathSync.native(path);
		} catch {
			return path;
		}
	}

	export function windowsPath(p: string): string {
		if (process.platform !== "win32") return p;
		return (
			p
				.replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
				// Git Bash for Windows paths are typically /<drive>/...
				.replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
				// Cygwin git paths are typically /cygdrive/<drive>/...
				.replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
				// WSL paths are typically /mnt/<drive>/...
				.replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
		);
	}

	export function overlaps(a: string, b: string): boolean {
		const relA = relative(a, b);
		const relB = relative(b, a);
		return !relA?.startsWith("..") || !relB?.startsWith("..");
	}

	export function contains(parent: string, child: string): boolean {
		return !relative(parent, child).startsWith("..");
	}

	export async function findUp(target: string, start: string, stop?: string): Promise<string[]> {
		let current = start;
		const result: string[] = [];
		while (true) {
			const search = join(current, target);
			if (await exists(search)) result.push(search);
			if (stop === current) break;
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
		return result;
	}

	export async function* up(options: { targets: string[]; start: string; stop?: string }): AsyncGenerator<string> {
		const { targets, start, stop } = options;
		let current = start;
		while (true) {
			for (const target of targets) {
				const search = join(current, target);
				if (await exists(search)) yield search;
			}
			if (stop === current) break;
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}

	// We cannot rely on path.resolve() here because git.exe may come from Git Bash, Cygwin, or MSYS2, so we need to translate these paths at the boundary.
	export function resolve(p: string): string {
		return normalizePath(pathResolve(windowsPath(p)));
	}

	export interface FileStat {
		isFile: boolean;
		isDirectory: boolean;
		isSymbolicLink: boolean;
		size: number;
		mtime: Date;
	}
}
