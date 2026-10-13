// Generates the module a bundled CLI passes to the harness's `Plugin.share`: every public module
// of the packages plugins share with it, with its export names and a lazy loader. Run under
// `--conditions=development`, so `@codeworksh/plugin` resolves to source as the bundle does.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const packages = ["effect", "@codeworksh/plugin"];
// The harness owns the sharing, so its dependencies are the copies to describe.
const require = createRequire(new URL("../../harness/package.json", import.meta.url));

/** Every subpath the package exports, with `*` patterns expanded against its files. */
function specifiers(name) {
	const manifest = require.resolve(`${name}/package.json`);
	const { exports } = JSON.parse(readFileSync(manifest, "utf8"));
	const result = [];
	for (const [key, target] of Object.entries(exports)) {
		if (key === "./package.json" || target === null) continue;
		if (!key.includes("*")) {
			result.push(name + key.slice(1));
			continue;
		}
		const pattern = typeof target === "string" ? target : (target.import ?? target.default);
		const [prefix, suffix] = pattern.split("*");
		const directory = join(dirname(manifest), prefix);
		for (const file of readdirSync(directory, { recursive: true })) {
			if (file.endsWith(suffix)) result.push(name + key.slice(1).replace("*", file.slice(0, -suffix.length)));
		}
	}
	return [...new Set(result)].sort();
}

async function describe(name) {
	const entries = [];
	for (const specifier of specifiers(name)) {
		let namespace;
		try {
			namespace = await import(require.resolve(specifier));
		} catch (error) {
			// A `*` expansion also reaches files a more specific `null` export hides.
			if (error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") continue;
			throw error;
		}
		const names = JSON.stringify(Object.keys(namespace).sort());
		entries.push(
			`\t\t${JSON.stringify(specifier)}: { names: ${names}, load: () => import(${JSON.stringify(specifier)}) },`,
		);
	}
	return `\t${JSON.stringify(name)}: {\n${entries.join("\n")}\n\t},`;
}

/** The module's source text. */
export async function source() {
	const body = await Promise.all(packages.map(describe));
	return `export default {\n${body.join("\n")}\n};\n`;
}
