import { spawn } from "node:child_process";
import { access, copyFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
	console.error("Usage: node scripts/publish.js <aikit|utils|@codeworksh/aikit|@codeworksh/utils> [npm publish args]");
	process.exit(1);
}

function hasFlag(args, flag) {
	return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

async function readJSON(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

function resolvePackageDir(target) {
	const normalized = target.replace(/\/+$/, "");
	const workspaceDir = workspaceMap.get(normalized);
	if (!workspaceDir) usage();

	return resolve(repoRoot, workspaceDir);
}

function run(command, args, cwd, envOverrides = {}, replaceEnv = false) {
	return new Promise((resolveExit) => {
		const proc = spawn(command, args, {
			cwd,
			env: replaceEnv ? envOverrides : { ...process.env, ...envOverrides },
			stdio: "inherit",
		});

		proc.on("close", (code) => resolveExit(code ?? 1));
		proc.on("error", () => resolveExit(1));
	});
}

function createSanitizedPublishEnv() {
	const env = { ...process.env };

	for (const key of Object.keys(env)) {
		if (
			key.startsWith("npm_config_") ||
			key.startsWith("pnpm_config_") ||
			key === "npm_command" ||
			key === "npm_execpath" ||
			key === "npm_node_execpath" ||
			key === "npm_package_json" ||
			key === "PNPM_PACKAGE_NAME"
		) {
			delete env[key];
		}
	}

	return env;
}

function compactObject(value) {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function rewritePublishPath(value) {
	if (typeof value !== "string") return value;
	if (!value.startsWith("./dist/pack/")) return value;
	return `./${value.slice("./dist/pack/".length)}`;
}

function rewritePublishValue(value) {
	if (typeof value === "string") {
		return rewritePublishPath(value);
	}

	if (Array.isArray(value)) {
		return value.map((entry) => rewritePublishValue(entry));
	}

	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewritePublishValue(entry)]));
	}

	return value;
}

async function resolveWorkspaceVersion(packageName) {
	const workspaceDir = workspaceMap.get(packageName);
	if (!workspaceDir) {
		throw new Error(`Unknown workspace dependency: ${packageName}`);
	}

	const workspaceManifest = await readJSON(resolve(repoRoot, workspaceDir, "package.json"));
	if (!workspaceManifest.version) {
		throw new Error(`Workspace package version missing for ${packageName}`);
	}

	return workspaceManifest.version;
}

function rewriteWorkspaceRange(range, version) {
	const workspaceRange = range.slice("workspace:".length);

	if (!workspaceRange || workspaceRange === "*") {
		return version;
	}

	if (workspaceRange === "^" || workspaceRange === "~") {
		return `${workspaceRange}${version}`;
	}

	if (workspaceRange.startsWith("^") || workspaceRange.startsWith("~")) {
		return `${workspaceRange[0]}${version}`;
	}

	if (workspaceRange.startsWith(".") || workspaceRange.startsWith("/")) {
		throw new Error(`Unsupported workspace dependency range: ${range}`);
	}

	return workspaceRange;
}

async function rewriteDependencyMap(dependencies) {
	if (!dependencies) return undefined;

	const rewritten = {};

	for (const [name, range] of Object.entries(dependencies)) {
		if (typeof range === "string" && range.startsWith("workspace:")) {
			rewritten[name] = rewriteWorkspaceRange(range, await resolveWorkspaceVersion(name));
			continue;
		}

		rewritten[name] = range;
	}

	return rewritten;
}

async function createPublishManifest(manifest) {
	return compactObject({
		name: manifest.name,
		version: manifest.version,
		description: manifest.description,
		keywords: manifest.keywords,
		homepage: manifest.homepage,
		bugs: manifest.bugs,
		license: manifest.license,
		author: manifest.author,
		repository: manifest.repository,
		type: manifest.type ?? "module",
		main: rewritePublishPath(manifest.main ?? manifest.module),
		module: rewritePublishPath(manifest.module),
		types: rewritePublishPath(manifest.types),
		exports: rewritePublishValue(manifest.exports) ?? {
			".": {
				types: rewritePublishPath(manifest.types),
				import: rewritePublishPath(manifest.module),
				default: rewritePublishPath(manifest.module),
			},
		},
		// Publish from dist/pack, so include the contents of that directory directly.
		files: ["**/*", "README.md", "LICENSE"],
		sideEffects: manifest.sideEffects,
		publishConfig: manifest.publishConfig,
		engines: manifest.engines,
		dependencies: await rewriteDependencyMap(manifest.dependencies),
		peerDependencies: await rewriteDependencyMap(manifest.peerDependencies),
		peerDependenciesMeta: manifest.peerDependenciesMeta,
		optionalDependencies: await rewriteDependencyMap(manifest.optionalDependencies),
	});
}

async function preparePublishDirectory(packageDir, manifest) {
	const buildDir = resolve(packageDir, "dist/pack");

	try {
		await access(buildDir);
	} catch {
		console.error(`Build output not found: ${buildDir}`);
		process.exit(1);
	}

	const publishDir = await mkdtemp(resolve(tmpdir(), `${manifest.name.replaceAll("/", "-")}-`));
	await cp(buildDir, publishDir, { recursive: true });
	await copyFile(resolve(packageDir, "README.md"), resolve(publishDir, "README.md"));
	await copyFile(resolve(repoRoot, "LICENSE"), resolve(publishDir, "LICENSE"));
	await writeFile(
		resolve(publishDir, "package.json"),
		`${JSON.stringify(await createPublishManifest(manifest), null, "\t")}\n`,
	);

	return publishDir;
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

const manifest = await readJSON(manifestPath);
if (!manifest.name) {
	console.error(`Package name missing in ${manifestPath}`);
	process.exit(1);
}

if (!manifest.name.startsWith("@codeworksh/")) {
	console.error(`Refusing to publish unscoped package: ${manifest.name}`);
	process.exit(1);
}

if (manifest.private) {
	console.error(`Refusing to publish private package: ${manifest.name}`);
	process.exit(1);
}

const publishArgs = ["publish"];

if (!hasFlag(forwardArgs, "--access")) {
	publishArgs.push("--access", manifest.publishConfig?.access ?? "public");
}

publishArgs.push(...forwardArgs);

console.error(`Building ${manifest.name} in ${packageDir}`);

const buildExitCode = await run("pnpm", ["run", "build"], packageDir);
if (buildExitCode !== 0) {
	process.exit(buildExitCode);
}

const publishDir = await preparePublishDirectory(packageDir, manifest);
console.error(`Publishing ${manifest.name} from ${publishDir}`);

const exitCode = await run("npm", publishArgs, publishDir, createSanitizedPublishEnv(), true);
await rm(publishDir, { recursive: true, force: true });

process.exit(exitCode);
