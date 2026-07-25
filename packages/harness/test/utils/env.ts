import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../../.env.local", import.meta.url));
const modelsPath = fileURLToPath(new URL("../../../../models.gen.json", import.meta.url));

if (existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

// Harness tests run with packages/harness as cwd, while aikit's generated
// model catalog lives at the workspace root.
process.env.CODEWORK_MODELS_FILE ??= modelsPath;
