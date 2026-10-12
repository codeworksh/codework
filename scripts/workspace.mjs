import { globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function workspaceDependencies(manifest) {
	return Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })
		.filter(([, range]) => typeof range === "string" && range.startsWith("workspace:"))
		.map(([name]) => name);
}

/**
 * Every published package, each after the workspace packages it depends on, so the publish order
 * follows the `package.json` graph instead of a list kept by hand.
 */
export function publishablePackages() {
	const byName = new Map();
	for (const file of globSync(["packages/*/package.json", "packages/*/npm/*/package.json"], {
		cwd: repoRoot,
	}).sort()) {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, file), "utf8"));
		if (manifest.private || !manifest.name?.startsWith("@codeworksh/")) continue;
		byName.set(manifest.name, { dir: resolve(repoRoot, dirname(file)), manifest });
	}

	const ordered = [];
	const visit = (name, path) => {
		const entry = byName.get(name);
		if (!entry || ordered.includes(entry)) return;
		if (path.includes(name)) throw new Error(`Workspace dependency cycle: ${[...path, name].join(" -> ")}`);
		for (const dependency of workspaceDependencies(entry.manifest)) visit(dependency, [...path, name]);
		ordered.push(entry);
	};
	for (const name of byName.keys()) visit(name, []);
	return ordered;
}

export function findPackage(name) {
	const entry = publishablePackages().find(({ manifest }) => manifest.name === name);
	if (!entry) throw new Error(`Unknown package: ${name}`);
	return entry;
}
