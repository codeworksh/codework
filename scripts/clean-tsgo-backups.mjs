// Deletes stale tsgo backup files left behind by `effect-tsgo patch`.
//
// The patch command backs up the real binary to `tsc.original`, and if that name is taken it
// writes `tsc.original.1`, `.2`, ... without ever cleaning up. On runners that restore
// node_modules from a build cache the backups accumulate across deploys until patch hard-fails
// at 101 with "Too many backup files exist". Removing them is safe: from the second patch
// onward the backup is just the previously-patched binary, and pnpm restores the pristine one
// whenever the package is re-materialized.
//
// `unpatch` also leaves `tsc.<uuid>.patched` files behind, so those go too.
//
// The unsuffixed `tsc.original` is deliberately kept: only the first patch writes it, so it is
// the pristine binary and the one `effect-tsgo unpatch` needs to restore correctly. Only the
// numbered duplicates are junk.
//
// Runs as part of `prepare`, so it must only use node builtins.
import * as NodeFS from "node:fs";

const patterns = [
	"node_modules/.pnpm/@typescript+typescript-*/node_modules/@typescript/typescript-*/lib/tsc{,.exe}.original.*",
	"node_modules/.pnpm/@typescript+typescript-*/node_modules/@typescript/typescript-*/lib/tsc*.patched",
];

const stale = patterns.flatMap((pattern) => NodeFS.globSync(pattern));

for (const file of stale) {
	NodeFS.rmSync(file, { force: true });
}

if (stale.length > 0) {
	console.log(`Removed ${stale.length} stale tsgo backup(s)`);
}
