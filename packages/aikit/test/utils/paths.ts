import { fileURLToPath } from "node:url";

export function repoRootPath(relativePath = ""): string {
	return fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url));
}

export const CODEWORK_MODELS_DEV = repoRootPath("models.json");
