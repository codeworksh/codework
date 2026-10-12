// `vp run bump <package> [bumpp args]`: runs bumpp in the package, which reads its bump.config.ts
// to commit and tag `@codeworksh/<package>@<version>` without pushing.
import { spawnSync } from "node:child_process";

import { findPackage } from "./workspace.mjs";

const [name, ...args] = process.argv.slice(2);
if (!name) {
	console.error("Usage: vp run bump <aikit|plugin|harness|tui|cli> [version] [bumpp args]");
	process.exit(1);
}

const { dir } = findPackage(`@codeworksh/${name}`);
const result = spawnSync("pnpm", ["exec", "bumpp", ...args], { cwd: dir, stdio: "inherit" });
process.exit(result.status ?? 1);
