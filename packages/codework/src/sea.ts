/* @effect-diagnostics nodeBuiltinImport:off -- this runs before the CLI, and with it any Effect runtime. */
/* oxlint-disable effecttsgo/process-env -- it hands the CLI its paths, before Effect's Config exists. */
/**
 * Entry of the standalone binary, a Node single executable application. Before the CLI starts it
 * unpacks the files that must exist on disk (the TUI, the image worker, and packages such as
 * just-bash that load files from beside their own modules) and gives plugins
 * the CLI's own `effect`, which has no copy on disk to resolve to.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAssetKeys, getRawAsset, isSea } from "node:sea";

/** Content hash of the embedded assets, so a build never runs another build's files. */
declare const CODEWORK_ASSETS: string;

const executables: ReadonlySet<string> = new Set(["codework-tui"]);

/** Where the assets live: a per-user cache in the binary, beside the bundle when it runs directly. */
function root(): string {
	if (!isSea()) return path.join(import.meta.dirname, "assets");
	const uid = process.getuid?.();
	const cache = path.join(tmpdir(), `codework-node-${uid ?? "user"}`);
	try {
		mkdirSync(cache, { mode: 0o700 });
	} catch (error) {
		if (!existsSync(cache)) throw error;
	}
	// The temp directory is shared: refuse a cache another user created or swapped for a symlink.
	const info = lstatSync(cache);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe asset cache: ${cache}`);
	if (uid !== undefined && info.uid !== uid) throw new Error(`asset cache is owned by another user: ${cache}`);
	chmodSync(cache, 0o700);
	return path.join(cache, `${CODEWORK_ASSETS}-${process.platform}-${process.arch}`);
}

function unpack(root: string): void {
	for (const key of getAssetKeys()) {
		const target = path.join(root, key);
		if (existsSync(target)) continue;
		mkdirSync(path.dirname(target), { recursive: true });
		// Write then rename, so a concurrent start never runs a partial file.
		const temporary = `${target}.${process.pid}.${process.hrtime.bigint()}.tmp`;
		writeFileSync(temporary, new Uint8Array(getRawAsset(key)));
		if (executables.has(key)) chmodSync(temporary, 0o755);
		try {
			renameSync(temporary, target);
		} catch (error) {
			rmSync(temporary, { force: true });
			if (!existsSync(target)) throw error;
		}
	}
}

const assets = root();
if (isSea()) unpack(assets);
process.env["CODEWORK_TUI_BIN"] ??= path.join(assets, "codework-tui");
process.env["CODEWORK_PACKAGES"] = assets;
process.env["CODEWORK_IMAGE_WORKER"] = path.join(assets, "worker.mjs");

const [{ Plugin }, { default: shared }] = await Promise.all([
	import("@codeworksh/harness/effect"),
	import("virtual:codework-shared"),
]);
Plugin.share(shared);
await Plugin.lendResolve();
await import("./index.ts");
