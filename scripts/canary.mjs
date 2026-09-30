import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";

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
const uploadedVersions = new Map();

async function waitForPublishedVersion(name, version) {
	const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`;
	// npm scans accepted uploads before exposing them; previous runs exceeded 15 minutes.
	const deadline = Date.now() + 60 * 60 * 1_000;
	while (Date.now() < deadline) {
		const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
		if (!response.ok && response.status !== 404) throw new Error(`Registry lookup failed: HTTP ${response.status}`);
		if (response.ok) {
			const tagsResponse = await fetch(
				`https://registry.npmjs.org/-/package/${name.replace("/", "%2f")}/dist-tags`,
				{ signal: AbortSignal.timeout(10_000) },
			);
			if (!tagsResponse.ok) throw new Error(`Dist-tag lookup failed: HTTP ${tagsResponse.status}`);
			if ((await tagsResponse.json()).canary === version) {
				console.error(`Verified ${name}@canary -> ${version}`);
				return;
			}
		}
		console.error(`Waiting for npm to make ${name}@${version} available`);
		await setTimeout(15_000);
	}
	throw new Error(
		`npm accepted ${name}@${version}, but it is still unavailable after 60 minutes. ` +
			"Check the package's Versions tab and npm notifications for scanning or review status. " +
			"The accepted upload may still become available after this workflow ends.",
	);
}

for (const { directory, manifest, version } of packages) {
	const args = [resolve(root, "scripts/publish.mjs"), directory, "--publish-version", version, "--tag", "canary"];
	const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies };
	for (const [name, range] of Object.entries(dependencies)) {
		if (typeof range !== "string" || !range.startsWith("workspace:")) continue;
		const dependencyVersion = uploadedVersions.get(name);
		if (!dependencyVersion) throw new Error(`Canary dependency has not been uploaded: ${name}`);
		args.push("--uploaded-dep", `${name}@${dependencyVersion}`);
	}
	const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
	uploadedVersions.set(manifest.name, version);
}

// All uploads are accepted before waiting, so npm can scan the packages concurrently.
await Promise.all(packages.map(({ manifest, version }) => waitForPublishedVersion(manifest.name, version)));
