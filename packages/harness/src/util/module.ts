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

/** Use Node's main loader even when the caller runs inside a bundler or test VM. */
export async function importModule(specifier: string): Promise<unknown> {
	const imported: unknown = await new Script(`import(${JSON.stringify(specifier)})`, {
		importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
	}).runInThisContext();
	if (typeof imported !== "object" || imported === null) return imported;
	const module = imported as Record<string, unknown>;
	const exports = module["module.exports"];
	if (exports !== module.default || (typeof exports !== "object" && typeof exports !== "function") || exports === null)
		return imported;
	return Object.assign({}, module, exports);
}

/** Node resolution scoped synchronously to the caller, following OpenCode's runtime importer. */
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
