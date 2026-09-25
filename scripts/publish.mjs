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
		"Usage: node scripts/publish.mjs <aikit|cli|codework|harness|plugin|@codeworksh/aikit|@codeworksh/cli|@codeworksh/harness|@codeworksh/plugin> [--dev] [--stage] [--dep <name>@<version>]... [npm publish args]",
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
	let publishVersion;
	const dependencyPins = new Map();

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

		if (arg === "--dep" || arg.startsWith("--dep=")) {
			const value = arg === "--dep" ? args[++index] : arg.slice("--dep=".length);
			// Split at the version's `@`, not a scope's.
			const at = value?.lastIndexOf("@") ?? -1;
			if (at <= 0 || at === value.length - 1) {
				console.error(`--dep expects <name>@<version>, got ${value ?? "nothing"}`);
				process.exit(1);
			}
			dependencyPins.set(value.slice(0, at), value.slice(at + 1));
			continue;
		}

		forwardArgs.push(arg);
	}

	if (publishVersion === "") {
		console.error("--publish-version requires a value");
		process.exit(1);
	}

	return { dependencyPins, dev, forwardArgs, publishVersion, stage };
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

/*
 * Registry questions go to endpoints the npm CDN does not cache. `npm view` reads the full package
 * document, which is cached for up to five minutes (`max-age=300`), so a version published a
 * moment ago looks missing even with `--prefer-online`.
 */
const registry = "https://registry.npmjs.org";
const registryPath = (name) => name.replace("/", "%2f");

/** Whether `name@version` is on the registry: the per-version document is served uncached. */
async function isPublished(name, version) {
	const response = await fetch(`${registry}/${registryPath(name)}/${version}`);
	if (response.status === 404) return false;
	if (!response.ok) throw new Error(`Registry lookup of ${name}@${version} failed: HTTP ${response.status}`);
	return true;
}

/** The version a dist-tag points at right now, or undefined. */
async function distTag(name, tag) {
	const response = await fetch(`${registry}/-/package/${registryPath(name)}/dist-tags`);
	return response.ok ? (await response.json())[tag] : undefined;
}

/**
 * The version of a workspace dependency to write into the published manifest.
 *
 * It is never guessed. The dependency's manifest version is used when the registry has it; a
 * version that is not released yet (a dev-only package) must be named with `--dep`, as a version or
 * as a dist-tag (`--dep @codeworksh/plugin@dev`) resolved to the exact version it points at now.
 * Falling back to a tag unasked once shipped a harness depending on a plugin build older than the
 * one published a minute before it, because the tag lookup was answered from a cache.
 *
 * Both paths ask the registry uncached, so a dependency published moments ago resolves.
 */
async function resolveWorkspaceVersion(packageName, dependencyPins) {
	const workspaceDir = workspaceMap.get(packageName);
	if (!workspaceDir) {
		throw new Error(`Unknown workspace dependency: ${packageName}`);
	}

	const pinned = dependencyPins.get(packageName);
	if (pinned) {
		// A version starts with a digit; anything else is a dist-tag.
		const version = /^\d/.test(pinned) ? pinned : await distTag(packageName, pinned);
		if (version && (await isPublished(packageName, version))) return version;
		throw new Error(`--dep ${packageName}@${pinned} is not on the registry.`);
	}

	const workspaceManifest = await readJSON(resolve(repoRoot, workspaceDir, "package.json"));
	if (!workspaceManifest.version) {
		throw new Error(`Workspace package version missing for ${packageName}`);
	}

	const declared = workspaceManifest.version;
	if (await isPublished(packageName, declared)) return declared;

	const dev = await distTag(packageName, "dev");
	throw new Error(
		`${packageName}@${declared} is not published. Pin the build to depend on with --dep ${packageName}@<version>` +
			(dev ? ` (its dev tag is ${dev}).` : "."),
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

async function rewriteDependencyMap(dependencies, dependencyPins) {
	if (!dependencies) return undefined;

	const rewritten = {};

	for (const [name, range] of Object.entries(dependencies)) {
		if (typeof range === "string" && range.startsWith("workspace:")) {
			rewritten[name] = rewriteWorkspaceRange(range, await resolveWorkspaceVersion(name, dependencyPins));
			continue;
		}

		rewritten[name] = range;
	}

	return rewritten;
}

async function createPublishManifest(manifest, version, dependencyPins) {
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
		exports: stripDevelopmentConditions(rewritePublishValue(manifest.exports)),
		// Publish from dist/pack, so include the contents of that directory directly.
		files: ["**/*", "README.md", "LICENSE"],
		sideEffects: manifest.sideEffects,
		publishConfig: manifest.publishConfig,
		engines: manifest.engines,
		dependencies: await rewriteDependencyMap(manifest.dependencies, dependencyPins),
		peerDependencies: await rewriteDependencyMap(manifest.peerDependencies, dependencyPins),
		peerDependenciesMeta: manifest.peerDependenciesMeta,
		optionalDependencies: await rewriteDependencyMap(manifest.optionalDependencies, dependencyPins),
	});
}

async function preparePublishDirectory(packageDir, publishManifest) {
	const buildDir = resolve(packageDir, "dist/pack");

	try {
		await access(buildDir);
	} catch {
		console.error(`Build output not found: ${buildDir}`);
		process.exit(1);
	}

	const publishDir = await mkdtemp(resolve(tmpdir(), `${publishManifest.name.replaceAll("/", "-")}-`));
	await cp(buildDir, publishDir, { recursive: true });
	await copyFile(resolve(packageDir, "README.md"), resolve(publishDir, "README.md"));
	await copyFile(resolve(repoRoot, "LICENSE"), resolve(publishDir, "LICENSE"));
	await writeFile(resolve(publishDir, "package.json"), `${JSON.stringify(publishManifest, null, "\t")}\n`);

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

/*
 * `latest` means stable, and a prerelease never reaches it.
 *
 * It is what `npm install <pkg>` hands someone who expressed no opinion, so a prerelease there
 * gives unstable code to everyone who did not ask for it. A developer wanting a dev build says so
 * with `@dev`, and that is the whole signal -- no flag can override this, because the only reason
 * to want one is a mistake.
 *
 * Guarded both ways: a stable version does not belong under `dev` either, or `npm install <pkg>`
 * and `@dev` start serving the same thing and the distinction stops meaning anything.
 */
const publishTag = optionValue([...publishArgs, ...forwardArgs], "--tag");
if (publishTag === "dev" && !isPrereleaseVersion(publishVersion)) {
	console.error(`Refusing to publish stable version ${publishVersion} with the dev dist-tag`);
	process.exit(1);
}
if (publishTag === undefined && isPrereleaseVersion(publishVersion)) {
	console.error(
		`Refusing to publish prerelease ${publishVersion} to latest; publish it with --dev, or release a stable version`,
	);
	process.exit(1);
}

publishArgs.push(...forwardArgs);

// State the plan before doing any of it: which version goes up, under which tag, and whether
// `latest` moves. These are exactly the three things a mis-publish gets wrong.
console.error(`Publishing ${manifest.name}@${publishVersion} under tag "${publishTag ?? "latest"}"`);
// Resolve dependency versions before building, so a missing one fails in seconds, not after a build.
const workspaceDependencies = new Set(
	[manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies].flatMap((map) =>
		Object.entries(map ?? {})
			.filter(([, range]) => typeof range === "string" && range.startsWith("workspace:"))
			.map(([name]) => name),
	),
);
for (const name of publishOptions.dependencyPins.keys()) {
	if (!workspaceDependencies.has(name)) {
		console.error(`--dep ${name}: ${manifest.name} has no workspace dependency by that name`);
		process.exit(1);
	}
}
let publishManifest;
try {
	publishManifest = await createPublishManifest(manifest, publishVersion, publishOptions.dependencyPins);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
for (const name of workspaceDependencies) {
	const version =
		publishManifest.dependencies?.[name] ??
		publishManifest.peerDependencies?.[name] ??
		publishManifest.optionalDependencies?.[name];
	console.error(`  ${name}: ${version}`);
}

console.error(`Building ${manifest.name}@${manifest.version} in ${packageDir}`);

const buildExitCode = await run("pnpm", ["run", "build"], packageDir);
await restoreFile(manifestPath, originalManifestText);

if (buildExitCode !== 0) {
	process.exit(buildExitCode);
}

const publishDir = await preparePublishDirectory(packageDir, publishManifest);
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

process.exit(exitCode);
