// Publishes the package chain for one channel: `canary`, `dev` or `latest`. CI runs it (see
// .github/workflows/publish.yml) after the TUI binaries are staged under packages/tui/dist/bin.
//
// canary/dev publish every package as a prerelease of its version (see scripts/version.mjs).
// latest publishes each package whose manifest version is not on npm yet, so a release is a
// local `vp run bump` followed by a run on main.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

import { distTags, isPublished } from "./registry.mjs";
import { releaseId, releaseVersion } from "./version.mjs";
import { publishablePackages, repoRoot as root, workspaceDependencies } from "./workspace.mjs";

const [channel, ...forwardArgs] = process.argv.slice(2);
if (!["canary", "dev", "latest"].includes(channel)) {
	console.error("Usage: vp run release <canary|dev|latest> [npm publish args]");
	process.exit(1);
}
const dryRun = forwardArgs.includes("--dry-run");

const id = releaseId(channel, { dryRun });
const packages = [];
for (const { manifest } of publishablePackages()) {
	if (id) {
		packages.push({ manifest, version: releaseVersion(manifest.version, channel, id) });
	} else if (await isPublished(manifest.name, manifest.version)) {
		console.error(`Skipping ${manifest.name}@${manifest.version}: already published`);
	} else {
		packages.push({ manifest, version: manifest.version });
	}
}
if (packages.length === 0) {
	console.error("Nothing to publish");
	process.exit(0);
}

async function waitForPublishedVersion(name, version) {
	// npm scans accepted uploads before exposing them; previous runs exceeded 15 minutes.
	const deadline = Date.now() + 60 * 60 * 1_000;
	while (Date.now() < deadline) {
		if ((await isPublished(name, version)) && (await distTags(name))[channel] === version) {
			console.error(`Verified ${name}@${channel} -> ${version}`);
			return;
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

// A consumer is pinned to the exact version of a dependency uploaded in this run, which npm may
// still be scanning; a dependency skipped on latest is already on the registry.
const uploadedVersions = new Map();
for (const { manifest, version } of packages) {
	const args = [resolve(root, "scripts/publish.mjs"), manifest.name, "--publish-version", version];
	if (channel !== "latest") args.push("--tag", channel);
	for (const name of workspaceDependencies(manifest)) {
		const uploaded = uploadedVersions.get(name);
		if (uploaded) args.push("--uploaded-dep", `${name}@${uploaded}`);
	}
	args.push(...forwardArgs);
	const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
	uploadedVersions.set(manifest.name, version);
}

if (!dryRun) {
	// All uploads are accepted before waiting, so npm can scan the packages concurrently.
	await Promise.all(packages.map(({ manifest, version }) => waitForPublishedVersion(manifest.name, version)));
}
