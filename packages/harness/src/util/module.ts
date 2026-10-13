/*!
 * Adapted from OpenCode packages/util/src/runtime/import.node.ts.
 *
 * MIT License
 *
 * Copyright (c) 2025 opencode
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/* oxlint-disable effecttsgo/async-function -- Native module loading exposes a Promise-based importer contract. */
// Resolution hooks cannot yield to Effect; existence checks must stay synchronous.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { statSync } from "node:fs";
import { registerHooks } from "node:module";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Script, constants } from "node:vm";

/**
 * Packages a plugin must share with the harness instead of using the copy installed beside it.
 *
 * A plugin is installed into the store as its own npm tree, so `effect` and the plugin SDK land
 * there a second time. Two copies of the *same version* are still two module instances, and
 * Effect Schema's checks do not survive the crossing: a schema built by one copy and evaluated by
 * the other reports every check as failed, so a tool whose success type is `Schema.Finite` dies
 * on "Expected a finite number" for `22800`. Nothing about that is visible at registration --
 * `Schema.isSchema` passes, the JSON Schema is derived correctly, and the tool reaches the model
 * -- so it surfaces on the first call rather than at boot.
 *
 * Resolution is the right place to fix it. A symlink into the store cannot be: a generation is
 * immutable and shared by every project on the machine, while the harness doing the loading is
 * whichever one is running now, and two applications embedding the harness need not agree on
 * where their `effect` lives.
 *
 * Each package maps to the `Symbol.for` key of its {@link SharedRegistry}.
 */
const sharedPackages: ReadonlyMap<string, string> = new Map([
	["effect", "codework.v1.effect"],
	["@codeworksh/plugin", "codework.v1.plugin"],
]);

/** One module of a shared package, as a bundled host publishes it. */
export interface SharedModule {
	/** Its export names; an ES module's exports must be known before it runs. */
	readonly names: ReadonlyArray<string>;
	readonly load: () => Promise<Record<string, unknown>>;
}

/**
 * A shared package's modules by specifier (`effect/Schema`), published on
 * `globalThis[Symbol.for(key)]` by a host that is a single bundled file, such as the standalone
 * binary. Such a host has no `effect` on disk to resolve to, so plugins get virtual modules that
 * re-export its own instances. Modules load on first import: `effect` alone has hundreds.
 */
export type SharedRegistry = Readonly<Record<string, SharedModule>>;

const sharedScheme = "codeworkshared:";

function registryOf(key: string): SharedRegistry | undefined {
	return (globalThis as Record<symbol, SharedRegistry | undefined>)[Symbol.for(key)];
}

/** Publish a bundled host's registries, by package name, before any plugin loads. */
export function share(packages: Readonly<Record<string, SharedRegistry>>): void {
	for (const [name, registry] of Object.entries(packages)) {
		const key = sharedPackages.get(name);
		if (key === undefined) throw new Error(`${name} is not a package shared with plugins`);
		(globalThis as Record<symbol, SharedRegistry>)[Symbol.for(key)] = registry;
	}
}

/** A virtual module re-exporting the host's instance of `specifier`. */
function sharedSource(key: string, specifier: string, names: ReadonlyArray<string>): string {
	const registry = `globalThis[Symbol.for(${JSON.stringify(key)})]`;
	return [
		`const m = await ${registry}[${JSON.stringify(specifier)}].load();`,
		...names.map((name, index) => `const $${index} = m[${JSON.stringify(name)}];`),
		// String export names, since some are reserved words (`Effect.void`).
		`export { ${names.map((name, index) => `$${index} as ${JSON.stringify(name)}`).join(", ")} };`,
	].join("\n");
}

/** The package a bare specifier names: `effect/Schema` -> `effect`, `@a/b/c` -> `@a/b`. */
function packageOf(specifier: string): string {
	if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":")) return "";
	const segments = specifier.split("/");
	return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? "");
}

/**
 * Resolve the shared packages to the host's own instances, for as long as `run` takes: from its
 * registry when it published one, otherwise as though this module had imported them. Anything
 * else resolves exactly as it would have.
 */
async function withSharedModules<A>(run: () => Promise<A>): Promise<A> {
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			const key = sharedPackages.get(packageOf(specifier));
			if (key === undefined) return nextResolve(specifier, context);
			const registry = registryOf(key);
			if (registry === undefined) return nextResolve(specifier, { ...context, parentURL: import.meta.url });
			// Falling back to the plugin's own copy would bring back the two-instance failure above.
			if (!Object.hasOwn(registry, specifier)) throw new Error(`${specifier} is not shared with plugins`);
			return { url: `${sharedScheme}${specifier}`, shortCircuit: true };
		},
		load(url, context, nextLoad) {
			if (!url.startsWith(sharedScheme)) return nextLoad(url, context);
			const specifier = url.slice(sharedScheme.length);
			const key = sharedPackages.get(packageOf(specifier))!;
			const shared = registryOf(key)![specifier]!;
			return { format: "module", source: sharedSource(key, specifier, shared.names), shortCircuit: true };
		},
	});
	try {
		return await run();
	} finally {
		hook.deregister();
	}
}

/** Use Node's main loader even when the caller runs inside a bundler or test VM. */
export async function importModule(specifier: string): Promise<unknown> {
	const imported: unknown = await withSharedModules(
		() =>
			new Script(`import(${JSON.stringify(specifier)})`, {
				importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
			}).runInThisContext() as Promise<unknown>,
	);
	if (typeof imported !== "object" || imported === null) return imported;
	const module = imported as Record<string, unknown>;
	const exports = module["module.exports"];
	if (exports !== module.default || (typeof exports !== "object" && typeof exports !== "function") || exports === null)
		return imported;
	return Object.assign({}, module, exports);
}

/** Node resolution scoped synchronously to the caller. */
export function resolveModule(specifier: string, directory: string, conditions?: ReadonlyArray<string>): string {
	const hook = registerHooks({
		resolve(target, context, nextResolve) {
			return nextResolve(target, {
				...context,
				parentURL: pathToFileURL(path.join(directory, "package.json")).href,
				...(conditions === undefined ? {} : { conditions: [...new Set([...context.conditions, ...conditions])] }),
			});
		},
	});
	try {
		const resolve = (target: string) => {
			const resolved = import.meta.resolve(path.isAbsolute(target) ? pathToFileURL(target).href : target);
			if (resolved.startsWith("file:")) statSync(new URL(resolved));
			return resolved;
		};
		try {
			return resolve(specifier);
		} catch (error) {
			if (path.extname(specifier) || !missing(error)) throw error;
			for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"]) {
				try {
					return resolve(specifier + extension);
				} catch (cause) {
					if (!missing(cause)) throw cause;
				}
			}
			throw error;
		}
	} finally {
		hook.deregister();
	}
}

function missing(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		["ENOENT", "ENOTDIR", "ERR_MODULE_NOT_FOUND"].includes(String(error.code))
	);
}
