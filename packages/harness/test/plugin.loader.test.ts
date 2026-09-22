import { Effect } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { inspect } from "../src/plugin/loader.ts";

/**
 * How a module that would not import is classified.
 *
 * The reason is the whole value here: `plugin-import-failed` tells a person their plugin is
 * broken, while `plugin-not-compiled` tells them *which* thing to fix and who has to fix it. The
 * distinction only pays off if it fires exactly where it should, so both sides are asserted --
 * the installed layout that triggers it, and the local one that must not.
 *
 * Nothing is mocked. The fixtures are real directories and the failure is Node's own, because the
 * behaviour under test is Node's refusal to strip types under `node_modules` -- assert against a
 * hand-made error and the test passes forever after Node changes its mind.
 */

const PLUGIN = 'const id: string = "acme.tool.fixture";\nexport default { id, kind: "tool", setup: () => {} };\n';

const MANIFEST = (name: string) =>
	JSON.stringify({ name, version: "1.0.0", type: "module", main: "./index.ts" }, null, "\t");

/**
 * A plugin that ships TypeScript, written where the store puts an installed one.
 *
 * `installed` decides the only thing that matters: a package under `node_modules` is what Node
 * refuses to strip, and the same files one directory up load fine.
 */
const withPlugin = async (installed: boolean, body: (input: { plugin: string; root: string }) => Promise<void>) => {
	const root = await mkdtemp(join(tmpdir(), "codework-plugin-loader-"));
	try {
		const plugin = installed ? join(root, "node_modules", "acme-fixture") : join(root, "acme-fixture");
		await mkdir(plugin, { recursive: true });
		await writeFile(join(plugin, "package.json"), MANIFEST("acme-fixture"));
		await writeFile(join(plugin, "index.ts"), PLUGIN);
		await body({ plugin, root });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
};

const load = (plugin: string, root: string) =>
	Effect.runPromise(inspect(plugin, { cache: join(root, "cache"), hostDir: root }).pipe(Effect.result));

describe("classifying a module that would not import", () => {
	it("calls a plugin that ships typescript not-compiled, rather than blaming the import", async () =>
		withPlugin(true, async ({ plugin, root }) => {
			const result = await load(plugin, root);

			expect(result._tag).toBe("Failure");
			if (result._tag !== "Failure") return;
			expect(result.failure.reason).toBe("plugin-not-compiled");
			// Matched on Node's code, so the message is free to be whatever Node says.
			expect(result.failure.message).toContain("node_modules");
		}));

	it("strips types happily for a local plugin, which is the dev workflow", async () =>
		withPlugin(false, async ({ plugin, root }) => {
			const result = await load(plugin, root);

			// Same files, same TypeScript, one directory up: `plugin-not-compiled` must not fire
			// here or every single-file plugin under `extras/plugins` would be rejected.
			expect(result._tag).toBe("Success");
			if (result._tag !== "Success") return;
			expect(result.success).toMatchObject({ id: "acme.tool.fixture" });
		}));
});
