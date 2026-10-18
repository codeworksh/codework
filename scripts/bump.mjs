// `vp run bump <package> [bumpp args]`: runs bumpp in the package, which reads its bump.config.ts
// to commit and tag `@codeworksh/<package>@<version>` without pushing.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { findPackage, repoRoot } from "./workspace.mjs";

const [name, ...args] = process.argv.slice(2);
if (!name) {
	console.error("Usage: vp run bump <aikit|plugin|harness|tui|cli|desktop> [version] [bumpp args]");
	process.exit(1);
}

// The desktop app ships as installers, not on npm, so it is not among the published packages.
const dir = name === "desktop" ? resolve(repoRoot, "apps/desktop") : findPackage(`@codeworksh/${name}`).dir;
const result = spawnSync("pnpm", ["exec", "bumpp", ...args], { cwd: dir, stdio: "inherit" });
process.exit(result.status ?? 1);
