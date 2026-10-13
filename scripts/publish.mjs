import { spawn } from "node:child_process";
import { access, copyFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { isPublished } from "./registry.mjs";
import { findPackage, repoRoot, workspaceDependencies } from "./workspace.mjs";

function usage() {
	console.error(
		"Usage: node scripts/publish.mjs <@codeworksh/name> [--publish-version <version>] [--uploaded-dep <name>@<version>]... [npm publish args]",
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
	let publishVersion;
	const uploadedDependencies = new Map();

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") continue;

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

		if (arg === "--uploaded-dep" || arg.startsWith("--uploaded-dep=")) {
			const value = arg === "--uploaded-dep" ? args[++index] : arg.slice("--uploaded-dep=".length);
			// Split at the version's `@`, not a scope's.
			const at = value?.lastIndexOf("@") ?? -1;
			const version = at > 0 ? value.slice(at + 1) : "";
			if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
				console.error(`--uploaded-dep expects <name>@<exact version>, got ${value ?? "nothing"}`);
				process.exit(1);
			}
			uploadedDependencies.set(value.slice(0, at), version);
			continue;
		}

		forwardArgs.push(arg);
	}

	if (publishVersion === "") {
		console.error("--publish-version requires a value");
		process.exit(1);
	}

	return { uploadedDependencies, forwardArgs, publishVersion };
}

async function restoreFile(path, content) {
	const current = await readFile(path, "utf8");
	if (current !== content) {
		await writeFile(path, content);
	}
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
 * It is never guessed. A dependency uploaded earlier in the same release run (`--uploaded-dep`) is
 * taken as given, since npm may still be scanning it; anything else must already be on the
 * registry at its manifest version.
 */
async function resolveWorkspaceVersion(packageName, uploadedDependencies) {
	const uploaded = uploadedDependencies.get(packageName);
	if (uploaded) return uploaded;

	const declared = findPackage(packageName).manifest.version;
	if (await isPublished(packageName, declared)) return declared;
	throw new Error(`${packageName}@${declared} is not published; release it first.`);
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

async function rewriteDependencyMap(dependencies, uploadedDependencies) {
	if (!dependencies) return undefined;

	const rewritten = {};

	for (const [name, range] of Object.entries(dependencies)) {
		if (typeof range === "string" && range.startsWith("workspace:")) {
			const version = await resolveWorkspaceVersion(name, uploadedDependencies);
			// A prerelease is pinned exactly; a range would also match other builds of the same channel.
			rewritten[name] = isPrereleaseVersion(version) ? version : rewriteWorkspaceRange(range, version);
			continue;
		}

		rewritten[name] = range;
	}

	return rewritten;
}

async function createPublishManifest(manifest, version, uploadedDependencies) {
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
		// A platform package installs only where its binary runs.
		os: manifest.os,
		cpu: manifest.cpu,
		dependencies: await rewriteDependencyMap(manifest.dependencies, uploadedDependencies),
		peerDependencies: await rewriteDependencyMap(manifest.peerDependencies, uploadedDependencies),
		peerDependenciesMeta: manifest.peerDependenciesMeta,
		optionalDependencies: await rewriteDependencyMap(manifest.optionalDependencies, uploadedDependencies),
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

let packageDir;
try {
	packageDir = findPackage(target).dir;
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	usage();
}
const manifestPath = resolve(packageDir, "package.json");
const originalManifestText = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(originalManifestText);

const publishArgs = ["publish"];
const publishVersion = publishOptions.publishVersion ?? manifest.version;

if (!hasFlag(forwardArgs, "--access")) {
	publishArgs.push("--access", manifest.publishConfig?.access ?? "public");
}

/*
 * `latest` means stable, and a prerelease never reaches it.
 *
 * It is what `npm install <pkg>` hands someone who expressed no opinion, so a prerelease there
 * gives unstable code to everyone who did not ask for it. Guarded both ways: a stable version does
 * not belong under a preview tag either, or the tags stop meaning anything.
 */
const publishTag = optionValue(forwardArgs, "--tag") ?? "latest";
if (publishTag === "latest" && isPrereleaseVersion(publishVersion)) {
	console.error(`Refusing to publish prerelease ${publishVersion} to latest`);
	process.exit(1);
}
if (publishTag !== "latest" && !isPrereleaseVersion(publishVersion)) {
	console.error(`Refusing to publish stable version ${publishVersion} under the ${publishTag} tag`);
	process.exit(1);
}

publishArgs.push(...forwardArgs);

// State the plan before doing any of it: which version goes up, under which tag, and whether
// `latest` moves. These are exactly the three things a mis-publish gets wrong.
console.error(`Publishing ${manifest.name}@${publishVersion} under tag "${publishTag}"`);
// Resolve dependency versions before building, so a missing one fails in seconds, not after a build.
let publishManifest;
try {
	publishManifest = await createPublishManifest(manifest, publishVersion, publishOptions.uploadedDependencies);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
for (const name of workspaceDependencies(manifest)) {
	const version =
		publishManifest.dependencies?.[name] ??
		publishManifest.peerDependencies?.[name] ??
		publishManifest.optionalDependencies?.[name];
	console.error(`  ${name}: ${version}`);
}

console.error(`Building ${manifest.name}@${publishVersion} in ${packageDir}`);

// A bundle that imports its package.json inlines the version, so build with the one being published.
await writeFile(manifestPath, originalManifestText.replace(/"version": "[^"]*"/, `"version": "${publishVersion}"`));
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
