import { Effect, Schema } from "effect";
import { importModule, resolveModule } from "../util/module.ts";
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

const official = new Set(["@codeworksh/harness/sandboxes/vercel", "@codeworksh/harness/sandboxes/daytona"]);

/**
 * Resolves driver package specifiers against `hostCwd` -- the OS process's
 * directory, supplied by the caller. This is host module resolution, not sandbox
 * addressing: a driver package lives on the host filesystem no matter which
 * namespace the sandbox it builds will serve. Required rather than defaulted so
 * it can never silently disagree with the directory the harness was started in.
 */
export const packageResolver = (
	hostCwd: string,
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
		const url = yield* Effect.try({
			try: () => resolveModule(specifier, hostCwd, conditions),
			catch: (reason) => new SandboxDriverLoadError({ specifier, phase: "resolve", reason: String(reason) }),
		});
		return {
			specifier,
			url,
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
	/** The OS process's directory. See {@link packageResolver}. */
	readonly hostCwd: string;
	readonly resolve?: Resolver;
	readonly import?: Importer;
}

export const load = Effect.fn("SandboxDriverLoader.load")(function* (entry: Entry, options: Options) {
	if (isRegistration(entry)) return entry;
	const specifier = typeof entry === "string" ? entry : entry.package;
	const rawOptions = typeof entry === "string" ? {} : (entry.options ?? {});
	const resolved = yield* (options.resolve ?? packageResolver(options.hostCwd))(specifier);
	const imported = yield* Effect.tryPromise({
		try: () => (options.import ?? importModule)(resolved.url),
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
	options: Options,
): Effect.Effect<ReadonlyArray<SandboxDriver.Registration>, SandboxDriverLoadError> =>
	Effect.forEach(entries, (entry) => load(entry, options));

export * as SandboxDriverLoader from "./loader.ts";
