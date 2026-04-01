import { fileURLToPath } from "node:url";

export function repoRootPath(relativePath = ""): string {
	return fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url));
}

export const ROOT_MODELS_PATH = repoRootPath("models.json");
