import { spawn } from "node:child_process";
import { access, copyFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceMap = new Map([
	["aikit", "packages/aikit"],
	["@codeworksh/aikit", "packages/aikit"],
	["codework", "packages/codework"],
	["cli", "packages/codework"],
	["@codeworksh/cli", "packages/codework"],
	["harness", "packages/harness"],
	["@codeworksh/harness", "packages/harness"],
	["plugin", "packages/plugin"],
	["@codeworksh/plugin", "packages/plugin"],
]);

function usage() {
	console.error(
		"Usage: node scripts/publish.mjs <aikit|cli|codework|harness|plugin|@codeworksh/aikit|@codeworksh/cli|@codeworksh/harness|@codeworksh/plugin> [--dev] [--latest] [--stage] [npm publish args]",
	);
	process.exit(1);
}

function hasFlag(args, flag) {
	return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function optionValue(args, flag) {
	const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
	if (index === -1) return undefined;

	const arg = args[index];
	if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);

	return args[index + 1];
}

function parsePublishOptions(args) {
	const forwardArgs = [];
	let dev = false;
	let stage = false;
	let latest = false;
	let publishVersion;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") continue;

		if (arg === "--dev") {
			dev = true;
			continue;
		}

		if (arg === "--stage") {
			stage = true;
			continue;
		}

		if (arg === "--latest") {
			latest = true;
			continue;
		}

		if (arg === "--publish-version") {
			publishVersion = args[index + 1];
			if (!publishVersion || publishVersion.startsWith("--")) {
				console.error("--publish-version requires a value");
				process.exit(1);
			}

			index++;
			continue;
		}

		if (arg.startsWith("--publish-version=")) {
			publishVersion = arg.slice("--publish-version=".length);
			continue;
		}

		forwardArgs.push(arg);
	}

	if (publishVersion === "") {
		console.error("--publish-version requires a value");
		process.exit(1);
	}

	return { dev, forwardArgs, latest, publishVersion, stage };
}

async function readJSON(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function restoreFile(path, content) {
	const current = await readFile(path, "utf8");
	if (current !== content) {
		await writeFile(path, content);
	}
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

/** Run a command and return its stdout, or undefined when it fails. For asking npm a question. */
function capture(command, args) {
	return new Promise((resolveOutput) => {
		const proc = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		proc.stdout.on("data", (chunk) => {
			out += chunk;
		});
		proc.on("close", (code) => resolveOutput(code === 0 ? out.trim() : undefined));
		proc.on("error", () => resolveOutput(undefined));
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

function createDevPrereleaseId() {
	const runNumber = process.env.GITHUB_RUN_NUMBER;
	const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
	const sha = process.env.GITHUB_SHA?.slice(0, 8);

	if (runNumber && runAttempt && sha) {
		return `${runNumber}.${runAttempt}.${sha}`;
	}

	const now = new Date();
	const timestamp = [
		now.getUTCFullYear(),
		String(now.getUTCMonth() + 1).padStart(2, "0"),
		String(now.getUTCDate()).padStart(2, "0"),
		String(now.getUTCHours()).padStart(2, "0"),
		String(now.getUTCMinutes()).padStart(2, "0"),
		String(now.getUTCSeconds()).padStart(2, "0"),
	].join("");

	return timestamp;
}

function createDevVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
	if (!match) {
		throw new Error(`Cannot create dev version from invalid semver: ${version}`);
	}

	// Dev builds are prereleases of the current target version (e.g. 0.6.0 -> 0.6.0-dev.<id>),
	// so they sort just below the eventual stable 0.6.0 release.
	return `${match[1]}.${match[2]}.${match[3]}-dev.${createDevPrereleaseId()}`;
}

function isPrereleaseVersion(version) {
	return /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

function rewritePublishPath(value) {
	if (typeof value !== "string") return value;
	if (!value.startsWith("./dist/pack/")) return value;
	return `./${value.slice("./dist/pack/".length)}`;
}

/**
 * Drop the `development` condition from a published exports map.
 *
 * It points at `./src/*.ts`, and the tarball is built from `dist/pack` -- no sources are in it.
 * A consumer resolving under that condition (vite dev, vitest, or this repo's own `start` script,
 * which passes `--conditions=development`) therefore gets ERR_MODULE_NOT_FOUND for a package that
 * installed cleanly. Publishing a condition the artifact cannot satisfy is never right, so it is
 * removed here rather than repointed.
 */
function stripDevelopmentConditions(value) {
	if (Array.isArray(value)) return value.map((entry) => stripDevelopmentConditions(entry));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== "development")
				.map(([key, entry]) => [key, stripDevelopmentConditions(entry)]),
		);
	}
	return value;
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

/**
 * The version of a workspace dependency to write into the published manifest.
 *
 * The manifest version is the right answer only when that version was actually released. A
 * package published exclusively as a prerelease has none: `@codeworksh/plugin`'s manifest says
 * `0.0.1` while the registry holds only `0.0.1-dev.*`, so writing the manifest version verbatim
 * ships a dependency that resolves to nothing and every install fails with ETARGET.
 *
 * So ask the registry. Prefer the manifest version when it exists, and fall back to whatever the
 * dependency's `dev` tag points at. That needs no per-package configuration and stays correct as
 * packages move between prerelease and stable: `@codeworksh/aikit@0.8.0` is a real release and
 * resolves to itself, while a dev-only package resolves to its newest dev build.
 *
 * The range is exact, which matters here: a caret never matches a prerelease, so `^0.0.1` would
 * not select `0.0.1-dev.5` even once it exists.
 */
async function resolveWorkspaceVersion(packageName) {
	const workspaceDir = workspaceMap.get(packageName);
	if (!workspaceDir) {
		throw new Error(`Unknown workspace dependency: ${packageName}`);
	}

	const workspaceManifest = await readJSON(resolve(repoRoot, workspaceDir, "package.json"));
	if (!workspaceManifest.version) {
		throw new Error(`Workspace package version missing for ${packageName}`);
	}

	const declared = workspaceManifest.version;
	if (await capture("npm", ["view", `${packageName}@${declared}`, "version"])) return declared;

	const dev = await capture("npm", ["view", `${packageName}@dev`, "version"]);
	if (dev) {
		console.error(`  ${packageName}: ${declared} is unpublished; depending on ${dev} (its dev tag)`);
		return dev;
	}

	throw new Error(
		`Cannot depend on ${packageName}: neither ${declared} nor a dev tag is published. Publish it first.`,
	);
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

async function createPublishManifest(manifest, version) {
	return compactObject({
		name: manifest.name,
		version,
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
		bin: (() => {
			const rewritten = rewritePublishValue(manifest.bin);
			if (typeof rewritten === "string" && rewritten.startsWith("./")) return rewritten.slice(2);
			if (typeof rewritten === "object" && rewritten !== null) {
				return Object.fromEntries(
					Object.entries(rewritten).map(([k, v]) => [
						k,
						typeof v === "string" && v.startsWith("./") ? v.slice(2) : v,
					]),
				);
			}
			return rewritten;
		})(),
		exports: stripDevelopmentConditions(rewritePublishValue(manifest.exports)) ?? {
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

async function preparePublishDirectory(packageDir, manifest, version) {
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
		`${JSON.stringify(await createPublishManifest(manifest, version), null, "\t")}\n`,
	);

	return publishDir;
}

const [target, ...rawForwardArgs] = process.argv.slice(2);
if (!target) usage();

const publishOptions = parsePublishOptions(rawForwardArgs);
const forwardArgs = publishOptions.forwardArgs;

const packageDir = resolvePackageDir(target);
const manifestPath = resolve(packageDir, "package.json");

try {
	await access(manifestPath);
} catch {
	console.error(`Package manifest not found: ${manifestPath}`);
	process.exit(1);
}

const originalManifestText = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(originalManifestText);
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

const publishArgs = publishOptions.stage ? ["stage", "publish", "."] : ["publish"];
const publishVersion =
	publishOptions.publishVersion ?? (publishOptions.dev ? createDevVersion(manifest.version) : manifest.version);

if (!hasFlag(forwardArgs, "--access")) {
	publishArgs.push("--access", manifest.publishConfig?.access ?? "public");
}

if (publishOptions.dev && !hasFlag(forwardArgs, "--tag")) {
	publishArgs.push("--tag", "dev");
}

const publishTag = optionValue([...publishArgs, ...forwardArgs], "--tag");
if (publishTag === "dev" && !isPrereleaseVersion(publishVersion)) {
	console.error(`Refusing to publish stable version ${publishVersion} with the dev dist-tag`);
	process.exit(1);
}

publishArgs.push(...forwardArgs);

// State the plan before doing any of it: which version goes up, under which tag, and whether
// `latest` moves. These are exactly the three things a mis-publish gets wrong.
console.error(
	`Publishing ${manifest.name}@${publishVersion} under tag "${publishTag ?? "latest"}"` +
		`${publishOptions.latest && publishTag !== undefined ? ", and moving latest to it" : ""}`,
);
console.error(`Building ${manifest.name}@${manifest.version} in ${packageDir}`);

const buildExitCode = await run("pnpm", ["run", "build"], packageDir);
await restoreFile(manifestPath, originalManifestText);

if (buildExitCode !== 0) {
	process.exit(buildExitCode);
}

const publishDir = await preparePublishDirectory(packageDir, manifest, publishVersion);
console.error(`Publishing ${manifest.name}@${publishVersion} from ${publishDir}`);
const npmCacheDir = await mkdtemp(resolve(tmpdir(), "codework-npm-cache-"));
const exitCode = await run(
	"npm",
	publishArgs,
	publishDir,
	{ ...createSanitizedPublishEnv(), npm_config_cache: npmCacheDir },
	true,
);
await rm(publishDir, { recursive: true, force: true });
await rm(npmCacheDir, { recursive: true, force: true });

/*
 * `latest` is assigned once, on a package's first publish, and never moves again on its own --
 * `npm publish --tag dev` sets `dev` and leaves `latest` on whatever went up first. For a package
 * released only as prereleases that means `npm install <pkg>` keeps serving the oldest build ever
 * published, which is how a known-broken one stayed on `latest` here.
 *
 * Opt in rather than implied by `--dev`: a package with a real release (`@codeworksh/aikit@0.8.0`)
 * must not have `latest` dragged onto a prerelease by a routine dev publish.
 */
if (exitCode === 0 && publishOptions.latest && !hasFlag(forwardArgs, "--dry-run")) {
	const target = `${manifest.name}@${publishVersion}`;
	console.error(`Pointing latest at ${target}`);
	const tagExit = await run("npm", ["dist-tag", "add", target, "latest"], repoRoot);
	if (tagExit !== 0) {
		console.error(`Published ${target}, but could not move the latest tag; do it by hand.`);
		process.exit(tagExit);
	}
}

process.exit(exitCode);
