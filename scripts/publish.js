import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceMap = new Map([
	["aikit", "packages/aikit"],
	["@codeworksh/aikit", "packages/aikit"],
	["utils", "packages/utils"],
	["@codeworksh/utils", "packages/utils"],
]);

function usage() {
	console.error("Usage: node scripts/publish.js <aikit|utils|@codeworksh/name|packages/name> [npm publish args]");
	process.exit(1);
}

function hasFlag(args, flag) {
	return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function resolvePackageDir(target) {
	const normalized = target.replace(/\/+$/, "");
	const workspaceDir = workspaceMap.get(normalized) ?? normalized;
	return resolve(repoRoot, workspaceDir);
}

const [target, ...forwardArgs] = process.argv.slice(2);
if (!target) usage();

const packageDir = resolvePackageDir(target);
const manifestPath = resolve(packageDir, "package.json");

try {
	await access(manifestPath);
} catch {
	console.error(`Package manifest not found: ${manifestPath}`);
	process.exit(1);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!manifest.name) {
	console.error(`Package name missing in ${manifestPath}`);
	process.exit(1);
}

if (!manifest.name.startsWith("@codeworksh/")) {
	console.error(`Refusing to publish unscoped package: ${manifest.name}`);
	process.exit(1);
}

const publishArgs = ["publish"];

if (!hasFlag(forwardArgs, "--access")) {
	publishArgs.push("--access", manifest.publishConfig?.access ?? "public");
}

publishArgs.push(...forwardArgs);

console.error(`Publishing ${manifest.name} from ${packageDir}`);

const proc = spawn("npm", publishArgs, {
	cwd: packageDir,
	env: process.env,
	stdio: "inherit",
});

const exitCode = await new Promise((resolveExit) => {
	proc.on("close", (code) => resolveExit(code ?? 1));
	proc.on("error", () => resolveExit(1));
});

process.exit(exitCode);
