import { dirname } from "path";
import { mkdir, readFile, writeFile } from "fs/promises";

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
