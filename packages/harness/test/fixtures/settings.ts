import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const withSettings = async (
	test: (input: { root: string; local: string; custom: string; global: string }) => Promise<void>,
) => {
	const root = await mkdtemp(join(tmpdir(), "codework-settings-"));
	const local = join(root, ".codework", "config");
	const custom = join(root, "custom");
	const global = join(root, "home", "config");
	try {
		await Promise.all([local, custom, global].map((dir) => mkdir(dir, { recursive: true })));
		await test({ root, local, custom, global });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
};
