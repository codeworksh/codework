import { access } from "node:fs/promises";
import { join } from "node:path";

const pollIntervalMs = 100;
const timeoutMs = 30_000;

async function fileExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function waitForResources({ baseDir, files }) {
	const startTime = Date.now();

	while (Date.now() - startTime < timeoutMs) {
		const checks = await Promise.all(files.map((file) => fileExists(join(baseDir, file))));
		if (checks.every(Boolean)) {
			return;
		}

		await new Promise((resolve) => {
			setTimeout(resolve, pollIntervalMs);
		});
	}

	throw new Error(`Timed out waiting for resources: ${files.join(", ")}`);
}
