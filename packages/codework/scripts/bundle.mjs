// Bundles the CLI into one ESM file for the standalone binary, beside the assets the binary
// embeds and unpacks. Writes `dist/sea`:
//
//   codework.mjs     the CLI, entry `src/sea.ts`
//   assets/          worker.mjs, codework-tui, and node_modules/ for the packages that load
//                    files from beside their own modules (WASM, workers, native addons)
//
// Run under `--conditions=development` (see `scripts/shared.mjs`). The TUI comes from
// `CODEWORK_TUI_BIN`, else the local release build. `CODEWORK_VERSION` replaces the version the CLI
// reports, which a canary or dev release computes (scripts/version.mjs). Rebuilding xz statically
// needs cmake.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite-plus";
import { source } from "./shared.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "dist/sea");
const assets = join(out, "assets");
const harness = join(root, "../harness/node_modules");

// Resolved by the harness from `CODEWORK_PACKAGES` (see `src/sea.ts`) instead of being bundled.
const unpacked = ["just-bash", "@silvia-odwyer/photon-node"];
// Only run at install, where @mongodb-js/zstd fetches its prebuilt addon.
// Only run at install, where @mongodb-js/zstd fetches its prebuilt addon; or only serve just-bash's
// `js-exec`, which the harness leaves off (no `javascript` option).
const skipped = new Set(["prebuild-install", "node-addon-api", "quickjs-emscripten"]);
// Documentation and types, never loaded.
const unused = /\.(map|d\.[cm]?ts|md|zip)$/;
/** Per package, which of its files to ship, by path inside it: the rest serve what the harness leaves off. */
const ships = {
	// `python` (CPython, in vendor/) is off, and the harness imports dist/bundle, not the CLI in dist/bin.
	"just-bash": (file) => !file.startsWith("vendor") && !file.startsWith("dist/bin"),
	// The Node WASM build; the rest are asm.js, debug, browser and web worker builds.
	"sql.js": (file) => file === "dist" || !file.startsWith("dist/") || /^dist\/sql-wasm\.(js|wasm)$/.test(file),
};

/** Bundle `entry` and everything it imports into the single file `out/name`. */
const bundle = (entry, outDir, name, extra = {}) =>
	build({
		configFile: join(root, "vite.config.ts"),
		root,
		logLevel: "warn",
		ssr: { noExternal: true },
		...extra,
		build: {
			ssr: entry,
			target: "node26",
			outDir,
			emptyOutDir: false,
			minify: true,
			rollupOptions: {
				output: {
					format: "esm",
					entryFileNames: name,
					codeSplitting: false,
					// Inlined CommonJS dependencies (npm's installer among them) read these module globals.
					banner: "const __filename = import.meta.filename, __dirname = import.meta.dirname;",
				},
			},
		},
	});

rmSync(out, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });

await bundle(join(root, "../harness/src/tool/image/worker.ts"), assets, "worker.mjs");

/** Every package `names` needs at runtime, by name, with its directory in pnpm's store. */
function closure(names) {
	const found = new Map();
	const visit = (directory) => {
		const { name, dependencies, optionalDependencies } = JSON.parse(
			readFileSync(join(directory, "package.json"), "utf8"),
		);
		const seen = found.get(name);
		if (seen !== undefined) {
			if (seen !== directory) throw new Error(`two versions of ${name} to unpack: ${seen} and ${directory}`);
			return;
		}
		found.set(name, directory);
		// pnpm links a package's dependencies beside it, in the node_modules that holds it.
		const modules = name.startsWith("@") ? dirname(dirname(directory)) : dirname(directory);
		for (const dependency of Object.keys({ ...dependencies, ...optionalDependencies })) {
			const linked = join(modules, dependency);
			// An optional dependency for another platform is not installed.
			if (!skipped.has(dependency) && existsSync(linked)) visit(realpathSync(linked));
		}
	};
	for (const name of names) visit(realpathSync(join(harness, name)));
	return found;
}

const packages = closure(unpacked);
for (const [name, directory] of packages) {
	cpSync(directory, join(assets, "node_modules", name), {
		recursive: true,
		filter: (path) =>
			path === directory ||
			(basename(path) !== "node_modules" &&
				!unused.test(path) &&
				(ships[name]?.(relative(directory, path)) ?? true)),
	});
}

// node-liblzma links the system liblzma by default, which a user's machine may not have. Link
// xz in statically, and keep only the addon from the build.
const lzma = join(assets, "node_modules/node-liblzma");
const store = packages.get("node-liblzma");
const gyp = createRequire(import.meta.url).resolve("node-gyp/bin/node-gyp.js");
// The build reads node-addon-api's headers, which the addon does not need at runtime.
cpSync(realpathSync(join(dirname(store), "node-addon-api")), join(lzma, "node_modules/node-addon-api"), {
	recursive: true,
});
execFileSync(process.execPath, [gyp, "rebuild"], {
	cwd: lzma,
	stdio: "inherit",
	env: { ...process.env, USE_GLOBAL: "false", RUNTIME_LINK: "static" },
});
const addon = readFileSync(join(lzma, "build/Release/node_lzma.node"));
// Its build tree, downloaded xz sources and borrowed headers are not part of the addon.
for (const directory of ["build", "deps", "node_modules"]) rmSync(join(lzma, directory), { recursive: true });
mkdirSync(join(lzma, "build/Release"), { recursive: true });
writeFileSync(join(lzma, "build/Release/node_lzma.node"), addon);
const [inspect, ...flags] = process.platform === "darwin" ? ["otool", "-L"] : ["ldd"];
const linked = execFileSync(inspect, [...flags, join(lzma, "build/Release/node_lzma.node")]).toString();
if (/liblzma[.\d]*\.(dylib|so)/.test(linked))
	throw new Error(`node-liblzma still links liblzma dynamically:\n${linked}`);

const tui = process.env["CODEWORK_TUI_BIN"] ?? join(root, "../tui/target/release/codework-tui");
if (!existsSync(tui)) throw new Error(`missing TUI binary ${tui}: set CODEWORK_TUI_BIN or run cargo build --release`);
copyFileSync(tui, join(assets, "codework-tui"));
chmodSync(join(assets, "codework-tui"), 0o755);

const hash = createHash("sha256");
const files = readdirSync(assets, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
for (const file of files.map((entry) => join(entry.parentPath, entry.name)).sort()) {
	hash.update(relative(assets, file));
	hash.update(readFileSync(file));
}

await bundle(join(root, "src/sea.ts"), out, "codework.mjs", {
	define: { CODEWORK_ASSETS: JSON.stringify(hash.digest("hex").slice(0, 16)) },
	plugins: [
		{
			name: "codework:version",
			enforce: "pre",
			load: (id) =>
				id === join(root, "package.json") && process.env["CODEWORK_VERSION"] !== undefined
					? JSON.stringify({ ...JSON.parse(readFileSync(id, "utf8")), version: process.env["CODEWORK_VERSION"] })
					: undefined,
		},
		{
			name: "codework:shared",
			resolveId: (id) => (id === "virtual:codework-shared" ? "\0virtual:codework-shared" : undefined),
			load: (id) => (id === "\0virtual:codework-shared" ? source() : undefined),
		},
	],
});
