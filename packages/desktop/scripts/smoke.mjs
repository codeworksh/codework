import { access } from "node:fs/promises";
import { join } from "node:path";

const requiredFiles = ["dist/electron/main.cjs", "dist/electron/preload.cjs", "index.html"];

await Promise.all(
	requiredFiles.map(async (file) => {
		await access(join(process.cwd(), file));
	}),
);

process.stdout.write("desktop smoke-test passed\n");
