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
 */
const sharedPackages: ReadonlySet<string> = new Set(["effect", "@codeworksh/plugin"]);

/** The package a bare specifier names: `effect/Schema` -> `effect`, `@a/b/c` -> `@a/b`. */
function packageOf(specifier: string): string {
	if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":")) return "";
	const segments = specifier.split("/");
	return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? "");
}

/**
 * Resolve the shared packages as though this module had imported them, for as long as `run`
 * takes. Anything else resolves exactly as it would have.
 */
function withSharedModules<A>(run: () => Promise<A>): Promise<A> {
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			return sharedPackages.has(packageOf(specifier))
				? nextResolve(specifier, { ...context, parentURL: import.meta.url })
				: nextResolve(specifier, context);
		},
	});
	return run().finally(() => hook.deregister());
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
