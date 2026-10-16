// Builds the standalone binary `dist/sea/codework` for this machine's platform: official Node with
// the bundle from `scripts/bundle.mjs` injected as a single executable application, and its
// assets embedded. Injecting breaks a macOS binary's signature, so it is signed again ad hoc.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const version = "26.11.1";
// From https://nodejs.org/dist/v26.11.1/SHASUMS256.txt. Intel Macs are not a target.
const checksums = {
	"darwin-arm64": "d916511b55965e91be7a88e17f88d895b6793ceaba3e6c9b194aefe51c2c65ac",
	"linux-arm64": "170454fb022f5e9b5f6cc76c25fa32ef5100895be44eb04e92f9780591491bbf",
	"linux-x64": "15fc043a51a5783f2f4b634561091658f5a7f0e3db03f997dca3a8033a33e45b",
};

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "dist/sea");
const assets = join(out, "assets");
const target = `${process.platform}-${process.arch}`;

/** This platform's official Node, downloaded once and checked against its pinned hash. */
async function node() {
	const checksum = checksums[target];
	if (checksum === undefined) throw new Error(`no standalone binary is built for ${target}`);
	const name = `node-v${version}-${target}`;
	const cache = join(root, ".cache/node");
	const binary = join(cache, name, "bin/node");
	if (existsSync(binary)) return binary;
	const response = await fetch(`https://nodejs.org/dist/v${version}/${name}.tar.gz`);
	if (!response.ok) throw new Error(`downloading ${name}: HTTP ${response.status}`);
	const archive = Buffer.from(await response.arrayBuffer());
	const actual = createHash("sha256").update(archive).digest("hex");
	if (actual !== checksum) throw new Error(`${name}.tar.gz has sha256 ${actual}, expected ${checksum}`);
	mkdirSync(cache, { recursive: true });
	writeFileSync(join(cache, `${name}.tar.gz`), archive);
	execFileSync("tar", ["-xzf", `${name}.tar.gz`, `${name}/bin/node`], { cwd: cache });
	rmSync(join(cache, `${name}.tar.gz`));
	return binary;
}

if (!existsSync(join(out, "codework.mjs"))) throw new Error("no bundle in dist/sea: run `vp run bundle` first");
const files = readdirSync(assets, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
const config = {
	main: join(out, "codework.mjs"),
	mainFormat: "module",
	output: join(out, "codework"),
	disableExperimentalSEAWarning: true,
	// Snapshots and code cache would tie the blob to the building machine's V8 flags.
	useSnapshot: false,
	useCodeCache: false,
	// Plugins load through vm's main-context loader, which Node still marks experimental.
	execArgv: ["--disable-warning=ExperimentalWarning"],
	// The binary is not a Node: NODE_OPTIONS and runtime flags are the user's, not its own.
	execArgvExtension: "none",
	// Keyed by path inside assets/, which is where `src/sea.ts` unpacks each one.
	assets: Object.fromEntries(
		files.map((entry) => {
			const file = join(entry.parentPath, entry.name);
			return [relative(assets, file).split(sep).join("/"), file];
		}),
	),
};
writeFileSync(join(out, "sea.json"), `${JSON.stringify(config, null, "\t")}\n`);
execFileSync(await node(), ["--build-sea", join(out, "sea.json")], { stdio: "inherit" });
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", "--force", config.output]);
