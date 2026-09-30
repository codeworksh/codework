import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { GITHUB_RUN_NUMBER: run, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: sha } = process.env;
if (!run || !attempt || !sha) {
	throw new Error("Canary publishing requires GITHUB_RUN_NUMBER, GITHUB_RUN_ATTEMPT, and GITHUB_SHA");
}

// Publish dependencies first and pin consumers to this run, rather than a moving dist-tag.
const packages = ["aikit", "plugin", "harness", "codework"].map((directory) => {
	const manifest = JSON.parse(readFileSync(resolve(root, "packages", directory, "package.json"), "utf8"));
	const base = /^\d+\.\d+\.\d+/.exec(manifest.version)?.[0];
	if (!base) throw new Error(`Invalid package version: ${manifest.version}`);
	return { directory, manifest, version: `${base}-canary.${run}.${attempt}.g${sha.slice(0, 8)}` };
});
const versions = new Map(packages.map(({ manifest, version }) => [manifest.name, version]));

for (const { directory, manifest, version } of packages) {
	const args = [resolve(root, "scripts/publish.mjs"), directory, "--publish-version", version, "--tag", "canary"];
	const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies };
	for (const [name, range] of Object.entries(dependencies)) {
		if (typeof range !== "string" || !range.startsWith("workspace:")) continue;
		const dependencyVersion = versions.get(name);
		if (!dependencyVersion) throw new Error(`Unknown canary dependency: ${name}`);
		args.push("--dep", `${name}@${dependencyVersion}`);
	}
	const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
