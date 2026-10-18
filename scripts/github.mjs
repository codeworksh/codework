// GitHub Releases for one publish run: `node scripts/github.mjs <canary|dev|latest> <assets dir>`.
// The release jobs of .github/workflows/publish.yml run it after npm, so a release never names a
// version npm does not have.
//
// canary: `nightly`, one prerelease replaced on every push, carrying the desktop app, titled with
// the desktop app's version for the run.
// dev: `devel`, one prerelease replaced on every push, carrying the CLI binaries, so the installer
// has a fixed URL for the newest development build.
// latest: `<pkg>@v<version>` for each package not released yet; the CLI's carries the binaries
// and is marked latest. The tag is the one `vp run bump` made, or a new one at this commit.
import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { releaseId, releaseVersion } from "./version.mjs";
import { publishablePackages, repoRoot as root } from "./workspace.mjs";

const [channel, assetsDir] = process.argv.slice(2);
if (!["canary", "dev", "latest"].includes(channel) || !assetsDir) {
	console.error("Usage: node scripts/github.mjs <canary|dev|latest> <assets dir>");
	process.exit(1);
}
const assets = globSync("*", { cwd: assetsDir }).map((file) => resolve(assetsDir, file));
const sha = process.env.GITHUB_SHA;
if (!sha) throw new Error("GITHUB_SHA is not set; GitHub Releases are made in CI");

function gh(...args) {
	const result = spawnSync("gh", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
	if (result.error) throw result.error;
	return { ok: result.status === 0, stdout: result.stdout };
}

function ghOrThrow(...args) {
	const result = gh(...args);
	if (!result.ok) throw new Error(`gh ${args.join(" ")} failed`);
	return result.stdout;
}

/** `@codeworksh/cli` at `0.3.0` → `cli@v0.3.0`. */
const tagName = (name, version) => `${name.replace("@codeworksh/", "")}@v${version}`;

/** The newest stable tag of the package below `version`, so its notes cover only its own changes. */
function previousTag(name, version) {
	const prefix = tagName(name, "");
	const compare = (a, b) => a.localeCompare(b, "en", { numeric: true });
	const refs = JSON.parse(ghOrThrow("api", `repos/{owner}/{repo}/git/matching-refs/tags/${prefix}`));
	const previous = refs
		.map(({ ref }) => ref.slice(`refs/tags/${prefix}`.length))
		.filter((v) => /^\d+\.\d+\.\d+$/.test(v) && compare(v, version) < 0)
		.sort(compare)
		.at(-1);
	return previous && `${prefix}${previous}`;
}

const cli = publishablePackages().find(({ manifest }) => manifest.name === "@codeworksh/cli").manifest;

if (channel === "canary") {
	// The desktop app is private: it ships as installers, so it is not among the published packages.
	const desktop = JSON.parse(readFileSync(resolve(root, "apps/desktop/package.json"), "utf8"));
	const version = releaseVersion(desktop.version, channel, releaseId(channel));
	gh("release", "delete", "nightly", "--cleanup-tag", "--yes");
	ghOrThrow(
		"release",
		"create",
		"nightly",
		...assets,
		"--prerelease",
		"--latest=false",
		"--target",
		sha,
		"--title",
		`desktop@v${version}`,
		"--notes",
		[
			`CodeWork Canary desktop build ${version}, from ${sha}. Replaced on every canary push.`,
			"",
			"macOS builds are not signed or notarized yet. After installing, run:",
			'`xattr -dr com.apple.quarantine "/Applications/CodeWork Canary.app"`',
		].join("\n"),
	);
} else if (channel === "dev") {
	const version = releaseVersion(cli.version, channel, releaseId(channel));
	gh("release", "delete", "devel", "--cleanup-tag", "--yes");
	ghOrThrow(
		"release",
		"create",
		"devel",
		...assets,
		"--prerelease",
		"--target",
		sha,
		"--title",
		`cli@v${version}`,
		"--notes",
		`Development build ${version}, from ${sha}.`,
	);
} else {
	// The platform packages under packages/tui/npm ship with the launcher, which is the one release.
	const packages = publishablePackages()
		.filter(({ dir }) => basename(dirname(dir)) === "packages")
		.map(({ manifest }) => manifest)
		// The CLI goes last so it is the newest release, the one `releases/latest` points at.
		.sort((a, b) => (a.name === cli.name) - (b.name === cli.name));
	for (const { name, version } of packages) {
		const tag = tagName(name, version);
		if (gh("release", "view", tag).ok) {
			console.error(`${tag} is already released`);
			continue;
		}
		const isCli = name === cli.name;
		const start = previousTag(name, version);
		ghOrThrow(
			"release",
			"create",
			tag,
			...(isCli ? assets : []),
			isCli ? "--latest" : "--latest=false",
			"--target",
			sha,
			"--title",
			tag,
			"--generate-notes",
			...(start ? ["--notes-start-tag", start] : []),
		);
		console.error(`Released ${tag}`);
	}
}
