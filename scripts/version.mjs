// The versions one publish run gives its packages. canary and dev publish each package as a
// prerelease of its manifest version; latest publishes the manifest version as is.
//
//   node scripts/version.mjs <channel>             the run's release id (empty for latest)
//   node scripts/version.mjs <channel> <package>   that package's version, e.g. packages/codework
//
// The first job of .github/workflows/publish.yml computes the id once and hands it to the later
// jobs as CODEWORK_RELEASE_ID, so the npm packages and the standalone binary carry one version.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { repoRoot as root } from "./workspace.mjs";

/** dev: `<YYYYMMDDHHMMSS>` (UTC). canary: `<run>.<attempt>.g<sha>`. latest: none. */
export function releaseId(channel, { dryRun = false } = {}) {
	if (channel === "latest") return undefined;
	if (process.env.CODEWORK_RELEASE_ID) return process.env.CODEWORK_RELEASE_ID;
	const { GITHUB_RUN_NUMBER: run = "0", GITHUB_RUN_ATTEMPT: attempt = "0" } = process.env;
	if (!process.env.GITHUB_RUN_NUMBER && !dryRun) {
		throw new Error(`A ${channel} release runs in CI; locally only --dry-run is supported`);
	}
	if (channel === "dev") return new Date().toISOString().slice(0, 19).replace(/\D/g, "");
	const sha = spawnSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: root }).stdout.toString().trim();
	return `${run}.${attempt}.g${sha}`;
}

/** `version` as `channel` publishes it under the run's `id`. */
export function releaseVersion(version, channel, id) {
	const base = /^\d+\.\d+\.\d+/.exec(version)?.[0];
	if (!base) throw new Error(`Invalid package version: ${version}`);
	return id ? `${base}-${channel}.${id}` : version;
}

if (import.meta.main) {
	const [channel, pkg] = process.argv.slice(2);
	if (!["canary", "dev", "latest"].includes(channel)) {
		console.error("Usage: node scripts/version.mjs <canary|dev|latest> [package directory]");
		process.exit(1);
	}
	const id = releaseId(channel);
	if (pkg === undefined) console.log(id ?? "");
	else {
		const { version } = JSON.parse(readFileSync(resolve(root, pkg, "package.json"), "utf8"));
		console.log(releaseVersion(version, channel, id));
	}
}
