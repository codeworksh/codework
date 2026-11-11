import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testModel } from "./model.ts";

/**
 * A temp root with a project (`local`), a user config dir (`custom`) and a home (`global`). Both
 * user settings files name {@link testModel}; a test replacing one names it too.
 */
export const withSettings = async (
	test: (input: { root: string; local: string; custom: string; global: string }) => Promise<void>,
) => {
	const root = await mkdtemp(join(tmpdir(), "codework-settings-"));
	const local = join(root, ".codework");
	const custom = join(root, "custom");
	const global = join(root, "home");
	try {
		await Promise.all([local, custom, global].map((dir) => mkdir(dir, { recursive: true })));
		await Promise.all(
			[global, custom].map((dir) => writeFile(join(dir, "settings.jsonc"), JSON.stringify({ model: testModel }))),
		);
		await test({ root, local, custom, global });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
};
