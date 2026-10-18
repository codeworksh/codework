// `vp run package <canary|dev|latest> [electron-builder args]`: builds the web app, the app server
// and this app, then packages them for the channel under the run's version, e.g. `--mac --arm64 --dir`.
// In CI the version carries the run id; locally a dry-run id stands in.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { releaseId, releaseVersion } from "../../../scripts/version.mjs";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [channel, ...builderArgs] = process.argv.slice(2);
if (!["canary", "dev", "latest"].includes(channel)) {
	console.error("Usage: vp run package <canary|dev|latest> [electron-builder args]");
	process.exit(1);
}

const run = (command, args, cwd, env = process.env) => {
	const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
	if (result.status !== 0) process.exit(result.status ?? 1);
};

// One arch per run: the one asked for, else this machine's (Node names them as the file names do).
const arch = builderArgs.includes("--arm64") ? "arm64" : builderArgs.includes("--x64") ? "x64" : process.arch;

const { version: base } = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const version = releaseVersion(base, channel, releaseId(channel, { dryRun: !process.env.CI }));

run("vp", ["build"], path.resolve(desktopDir, "../web"));
run("vp", ["pack"], path.resolve(desktopDir, "../server"));
run("vp", ["pack"], desktopDir);
run(
	"pnpm",
	[
		"exec",
		"electron-builder",
		"--config",
		"electron-builder.config.ts",
		`-c.extraMetadata.version=${version}`,
		"--publish",
		"never",
		...builderArgs,
	],
	desktopDir,
	{ ...process.env, CODEWORK_CHANNEL: channel, CODEWORK_ARCH: arch },
);
