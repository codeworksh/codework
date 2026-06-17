import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../../.env.local", import.meta.url));

if (existsSync(envPath)) {
	process.loadEnvFile(envPath);
}
