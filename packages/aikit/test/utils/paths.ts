import { fileURLToPath } from "node:url";

export function repoRootPath(relativePath = ""): string {
	return fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url));
}

export const OPENCODE_MODELS_DEV_FILE = repoRootPath("models.json");
