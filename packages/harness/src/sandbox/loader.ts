import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { Effect, Schema } from "effect";
import { fileSystem, hostPath } from "../host.ts";
import { SandboxDriver } from "./driver.ts";
import { SandboxDriverLoadError } from "./errors.ts";

export interface PackageEntry {
	readonly package: string;
	readonly options?: unknown;
}

export type Entry = string | PackageEntry | SandboxDriver.Registration;

export interface Resolved {
	readonly specifier: string;
	readonly url: string;
	readonly source: Extract<SandboxDriver.Source, "builtin" | "package" | "file">;
}

export type Resolver = (specifier: string) => Effect.Effect<Resolved, SandboxDriverLoadError>;
export type Importer = (url: string) => Promise<unknown>;

interface PackageManifest {
	readonly exports?: unknown;
	readonly module?: unknown;
	readonly main?: unknown;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null;

const splitPackage = (specifier: string): { readonly name: string; readonly key: string } | undefined => {
	const parts = specifier.split("/");
	if (specifier.startsWith("@")) {
		if (parts.length < 2 || parts[0]?.length === 1 || parts[1]?.length === 0) return undefined;
		return { name: `${parts[0]}/${parts[1]}`, key: parts.length === 2 ? "." : `./${parts.slice(2).join("/")}` };
	}
	if (parts[0]?.length === 0) return undefined;
	return { name: parts[0]!, key: parts.length === 1 ? "." : `./${parts.slice(1).join("/")}` };
};

export const isPackageSpecifier = (specifier: string): boolean =>
	!specifier.startsWith(".") &&
	!specifier.startsWith("/") &&
	!specifier.startsWith("file:") &&
	!specifier.includes("\\") &&
	!specifier.includes(":") &&
	splitPackage(specifier) !== undefined;

const selectCondition = (value: unknown, conditions: ReadonlyArray<string>): string | undefined => {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const candidate of value) {
			const selected = selectCondition(candidate, conditions);
			if (selected !== undefined) return selected;
		}
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	for (const condition of conditions) {
		const selected = selectCondition(value[condition], conditions);
		if (selected !== undefined) return selected;
	}
	return undefined;
};

const exportedTarget = (
	manifest: PackageManifest,
	key: string,
	conditions: ReadonlyArray<string>,
): string | undefined => {
	const exports = manifest.exports;
	if (typeof exports === "string" || Array.isArray(exports))
		return key === "." ? selectCondition(exports, conditions) : undefined;
	if (!isRecord(exports)) {
		if (key !== ".") return undefined;
		return typeof manifest.module === "string"
			? manifest.module
			: typeof manifest.main === "string"
				? manifest.main
				: "./index.js";
	}
	const hasSubpaths = Object.keys(exports).some((name) => name.startsWith("."));
	if (!hasSubpaths) return selectCondition(key === "." ? exports : undefined, conditions);
	const exact = selectCondition(exports[key], conditions);
	if (exact !== undefined) return exact;
	for (const pattern of Object.keys(exports)
		.filter((name) => name.includes("*"))
		.sort((a, b) => b.length - a.length)) {
		const [prefix, suffix = ""] = pattern.split("*");
		if (!key.startsWith(prefix!) || !key.endsWith(suffix)) continue;
		const match = key.slice(prefix!.length, key.length - suffix.length);
		const target = selectCondition(exports[pattern], conditions);
		if (target !== undefined) return target.replaceAll("*", match);
	}
	return undefined;
};

const official = new Set(["@codeworksh/harness/sandboxes/vercel", "@codeworksh/harness/sandboxes/daytona"]);

export const packageResolver = (
	base = process.cwd(),
	conditions: ReadonlyArray<string> = ["node", "import", "default"],
): Resolver =>
	Effect.fn("SandboxDriverLoader.resolve")(function* (specifier: string) {
		if (!isPackageSpecifier(specifier)) {
			return yield* new SandboxDriverLoadError({
				specifier,
				phase: "resolve",
				reason: "expected an installed npm package specifier; filesystem paths are not supported yet",
			});
		}
		const parsed = splitPackage(specifier)!;
		const packageJson = yield* Effect.try({
			try: () => findPackageJSON(parsed.name, pathToFileURL(hostPath.resolve(base, "package.json"))),
			catch: (reason) => new SandboxDriverLoadError({ specifier, phase: "resolve", reason: String(reason) }),
		});
		if (packageJson === undefined) {
			return yield* new SandboxDriverLoadError({
				specifier,
				phase: "resolve",
				reason: `installed package was not found: ${parsed.name}`,
			});
		}
		const source = yield* fileSystem
			.readFileString(packageJson)
			.pipe(
				Effect.mapError(
					(reason) => new SandboxDriverLoadError({ specifier, phase: "resolve", reason: String(reason) }),
				),
			);
		const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(source).pipe(
			Effect.mapError(
				(reason) => new SandboxDriverLoadError({ specifier, phase: "resolve", reason: String(reason) }),
			),
		);
		const manifest: PackageManifest = isRecord(decoded) ? decoded : {};
		const target = exportedTarget(manifest, parsed.key, conditions);
		if (target === undefined || !target.startsWith("./")) {
			return yield* new SandboxDriverLoadError({
				specifier,
				phase: "resolve",
				reason: `package export is missing or unsupported: ${parsed.key}`,
			});
		}
		const root = hostPath.dirname(packageJson);
		const location = hostPath.resolve(root, target);
		if (location !== root && !location.startsWith(`${root}${hostPath.sep}`)) {
			return yield* new SandboxDriverLoadError({
				specifier,
				phase: "resolve",
				reason: "package export resolves outside its package root",
			});
		}
		return {
			specifier,
			url: pathToFileURL(location).href,
			source: official.has(specifier) ? "builtin" : "package",
		};
	});

interface LoadableModule {
	readonly apiVersion: number;
	readonly name: string;
	readonly options: Schema.Codec<unknown, unknown>;
	readonly make: (options: unknown) => unknown;
}

const isModule = (value: unknown): value is LoadableModule =>
	isRecord(value) &&
	typeof value.apiVersion === "number" &&
	typeof value.name === "string" &&
	Schema.isSchema(value.options) &&
	typeof value.make === "function";

const isRegistration = (value: unknown): value is SandboxDriver.Registration => {
	if (
		!isRecord(value) ||
		value.apiVersion !== SandboxDriver.apiVersion ||
		typeof value.source !== "string" ||
		!isRecord(value.registered)
	)
		return false;
	const registered = value.registered;
	const capabilities = registered.capabilities;
	return (
		typeof registered.name === "string" &&
		(registered.kind === "virtual" || registered.kind === "remote") &&
		isRecord(capabilities) &&
		["inspect", "reattach", "wake", "stop", "destroy", "cancels"].every(
			(capability) => typeof capabilities[capability] === "boolean",
		) &&
		Schema.isSchema(registered.createConfigCodec) &&
		Schema.isSchema(registered.runtimeConfigCodec) &&
		typeof registered.create === "function" &&
		typeof registered.attach === "function"
	);
};

const failure = (specifier: string, phase: SandboxDriverLoadError["phase"], reason: unknown, driver?: string) =>
	new SandboxDriverLoadError({
		specifier,
		phase,
		...(driver === undefined ? {} : { driver }),
		reason: String(reason),
	});

export interface Options {
	readonly resolve?: Resolver;
	readonly import?: Importer;
}

export const load = Effect.fn("SandboxDriverLoader.load")(function* (entry: Entry, options: Options = {}) {
	if (isRegistration(entry)) return entry;
	const specifier = typeof entry === "string" ? entry : entry.package;
	const rawOptions = typeof entry === "string" ? {} : (entry.options ?? {});
	const resolved = yield* (options.resolve ?? packageResolver())(specifier);
	const imported = yield* Effect.tryPromise({
		try: () => (options.import ?? ((url) => import(/* @vite-ignore */ url)))(resolved.url),
		catch: (reason) => failure(specifier, "import", reason),
	});
	const loaded = isRecord(imported) ? imported.default : undefined;
	if (!isModule(loaded)) return yield* failure(specifier, "module", "default export is not a sandbox driver module");
	if (loaded.apiVersion !== SandboxDriver.apiVersion) {
		return yield* failure(
			specifier,
			"api-version",
			`unsupported sandbox driver API version: ${loaded.apiVersion}`,
			loaded.name,
		);
	}
	const decoded = yield* Schema.decodeEffect(loaded.options)(rawOptions).pipe(
		Effect.mapError(() => failure(specifier, "options", "options did not match the module schema", loaded.name)),
	);
	const registration = yield* Effect.try({
		try: () => loaded.make(decoded),
		catch: (reason) => failure(specifier, "factory", reason, loaded.name),
	});
	if (!isRegistration(registration)) {
		return yield* failure(specifier, "registration", "module factory returned an invalid registration", loaded.name);
	}
	if (registration.registered.name !== loaded.name) {
		return yield* failure(
			specifier,
			"registration",
			`module name does not match driver name: ${registration.registered.name}`,
			loaded.name,
		);
	}
	return SandboxDriver.withSource(registration, resolved.source);
});

export const loadAll = (
	entries: ReadonlyArray<Entry>,
	options: Options = {},
): Effect.Effect<ReadonlyArray<SandboxDriver.Registration>, SandboxDriverLoadError> =>
	Effect.forEach(entries, (entry) => load(entry, options));

export * as SandboxDriverLoader from "./loader.ts";
