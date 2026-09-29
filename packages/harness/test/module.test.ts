import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { resolveModule } from "../src/util/module.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

const fixture = async (root: string, exports: unknown) => {
	const directory = join(root, "node_modules", "fixture");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fixture", type: "module", exports }));
	for (const name of ["import", "node", "development", "entry"])
		await writeFile(join(directory, `${name}.js`), `export default ${JSON.stringify(name)};`);
	return directory;
};

const url = (file: string) => pathToFileURL(realpathSync(file)).href;

describe("native module loading", () => {
	it("adds development conditions and respects wildcard exports and null exclusions", async () => {
		await using temp = await tmpdir();
		const directory = await fixture(temp.path, {
			".": { development: "./development.js", import: "./import.js" },
			"./*": "./*.js",
			"./private/*": null,
		});
		expect(resolveModule("fixture", temp.path, ["development"])).toBe(url(join(directory, "development.js")));
		expect(resolveModule("fixture/entry", temp.path)).toBe(url(join(directory, "entry.js")));
		expect(() => resolveModule("fixture/private/entry", temp.path)).toThrow();
	});

	it("does not bypass exports to guess a missing package entry", async () => {
		await using temp = await tmpdir();
		await fixture(temp.path, { "./entry": "./entry.js" });
		expect(() => resolveModule("fixture", temp.path)).toThrow();
	});

	it("resolves extensionless local TypeScript without evaluating it", async () => {
		await using temp = await tmpdir();
		await writeFile(join(temp.path, "entry.ts"), 'throw new Error("must not execute while resolving");');
		expect(resolveModule("./entry", temp.path)).toBe(url(join(temp.path, "entry.ts")));
		expect(() => resolveModule("./missing.ts", temp.path)).toThrow();
	});

	it("deregisters scoped hooks after both success and failure", async () => {
		await using temp = await tmpdir();
		const parents: Array<string | undefined> = [];
		const outer = registerHooks({
			resolve(specifier, context, nextResolve) {
				parents.push(context.parentURL);
				return nextResolve(specifier, context);
			},
		});
		try {
			expect(resolveModule("node:fs", temp.path)).toBe("node:fs");
			expect(() => resolveModule("./missing.js", temp.path)).toThrow();
			parents.length = 0;
			import.meta.resolve("node:path");
			expect(parents).toEqual([import.meta.url]);
		} finally {
			outer.deregister();
		}
	});
});
