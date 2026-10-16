// Stages a platform package's binary for publishing, run from its directory by `build`.
// CI downloads each target's build to `packages/tui/dist/bin/<package>/codework-tui`
// (the artifact is named after the unscoped package), and `scripts/publish.mjs`
// publishes `dist/pack`.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const name = manifest.name.split("/")[1];
const source = resolve("../../dist/bin", name, "codework-tui");
if (!existsSync(source)) {
	console.error(`Missing ${source}: binaries are built by the publish workflow (.github/workflows/publish.yml)`);
	process.exit(1);
}

mkdirSync("dist/pack/bin", { recursive: true });
const target = resolve("dist/pack/bin/codework-tui");
copyFileSync(source, target);
// Artifact downloads drop the executable bit.
chmodSync(target, 0o755);
