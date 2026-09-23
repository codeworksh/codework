import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname } from "path";

export async function readText(path: string): Promise<string> {
	return readFile(path, "utf-8");
}

export async function readJson<T = unknown>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf-8"));
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

/**
 * Write through a temp file and rename it into place, so a concurrent reader
 * sees either the old content or the new, never a partial file.
 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeJson(temp, data);
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}
