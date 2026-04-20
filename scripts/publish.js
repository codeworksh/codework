import { spawn } from "node:child_process";
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceMap = new Map([
	["aikit", "packages/aikit"],
	["@codeworksh/aikit", "packages/aikit"],
	["bridge", "packages/bridge"],
	["@codeworksh/bridge", "packages/bridge"],
	["utils", "packages/utils"],
	["@codeworksh/utils", "packages/utils"],
]);

function usage() {
	console.error("Usage: node scripts/publish.js <aikit|bridge|utils|@codeworksh/name|packages/name> [npm publish args]");
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
	const workspaceDir = workspaceMap.get(normalized) ?? normalized;
	return resolve(repoRoot, workspaceDir);
}

function run(command, args, cwd, envOverrides = {}) {
	return new Promise((resolveExit) => {
		const proc = spawn(command, args, {
			cwd,
			env: { ...process.env, ...envOverrides },
			stdio: "inherit",
		});

		proc.on("close", (code) => resolveExit(code ?? 1));
		proc.on("error", () => resolveExit(1));
	});
}

async function createPublishEnv() {
	const npmUserConfig = resolve(repoRoot, ".npmrc");

	try {
		await access(npmUserConfig);
		return {
			NPM_CONFIG_USERCONFIG: npmUserConfig,
		};
	} catch {
		return {};
	}
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
	const publishDir = resolve(packageDir, "dist/pack");

	try {
		await access(publishDir);
	} catch {
		console.error(`Build output not found: ${publishDir}`);
		process.exit(1);
	}

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

const publishArgs = ["publish"];

if (!hasFlag(forwardArgs, "--access")) {
	publishArgs.push("--access", manifest.publishConfig?.access ?? "public");
}

publishArgs.push(...forwardArgs);

console.error(`Building ${manifest.name} in ${packageDir}`);

const buildExitCode = await run("npm", ["run", "build"], packageDir);
if (buildExitCode !== 0) {
	process.exit(buildExitCode);
}

const publishDir = await preparePublishDirectory(packageDir, manifest);
console.error(`Publishing ${manifest.name} from ${publishDir}`);

const exitCode = await run("npm", publishArgs, publishDir, await createPublishEnv());

process.exit(exitCode);
