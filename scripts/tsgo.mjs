// Runs the TypeScript 7 (tsgo) binary that `effect-tsgo patch` rewrote, so typechecking
// reports Effect language-service diagnostics alongside ordinary type errors.
//
// `tsc` is ambiguous in this repo. Two packages provide that bin name: `typescript` (the TS 6
// compiler `vp pack` drives through its classic API) and `@typescript/native` (TS 7, patched).
// Which one a bare `tsc` resolves to depends on the directory you run it from -- at the repo
// root it is TS 7, but inside a package that declares the `typescript` peer it is TS 6. This
// resolves TS 7 explicitly so `typecheck` means the same thing everywhere.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const manifest = require.resolve("@typescript/native/package.json");
const { default: getExePath } = await import(new URL("lib/getExePath.js", pathToFileURL(manifest)).href);

const result = spawnSync(getExePath(), process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
