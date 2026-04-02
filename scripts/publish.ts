import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

type PackageManifest = {
	name?: string;
	publishConfig?: {
		access?: string;
	};
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceMap = new Map<string, string>([
	["aikit", "packages/aikit"],
	["@codeworksh/aikit", "packages/aikit"],
	["utils", "packages/utils"],
	["@codeworksh/utils", "packages/utils"],
]);

function usage(): never {
	console.error("Usage: bun run scripts/publish.ts <aikit|utils|@codeworksh/name|packages/name> [bun publish args]");
	process.exit(1);
}

function hasFlag(args: string[], flag: string): boolean {
	return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function resolvePackageDir(target: string): string {
	const normalized = target.replace(/\/+$/, "");
	const workspaceDir = workspaceMap.get(normalized) ?? normalized;
	return resolve(repoRoot, workspaceDir);
}

const [target, ...forwardArgs] = Bun.argv.slice(2);
if (!target) usage();

const packageDir = resolvePackageDir(target);
const manifestPath = resolve(packageDir, "package.json");

try {
	await access(manifestPath);
} catch {
	console.error(`Package manifest not found: ${manifestPath}`);
	process.exit(1);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
if (!manifest.name) {
	console.error(`Package name missing in ${manifestPath}`);
	process.exit(1);
}

if (!manifest.name.startsWith("@codeworksh/")) {
	console.error(`Refusing to publish unscoped package: ${manifest.name}`);
	process.exit(1);
}

const publishArgs = ["publish", "--cwd", packageDir];

if (!hasFlag(forwardArgs, "--access")) {
	publishArgs.push("--access", manifest.publishConfig?.access ?? "public");
}

publishArgs.push(...forwardArgs);

console.error(`Publishing ${manifest.name} from ${packageDir}`);

const proc = spawn("bun", publishArgs, {
	cwd: repoRoot,
	env: process.env,
	stdio: "inherit",
});

const exitCode = await new Promise<number>((resolveExit) => {
	proc.on("close", (code) => resolveExit(code ?? 1));
	proc.on("error", () => resolveExit(1));
});

process.exit(exitCode);
