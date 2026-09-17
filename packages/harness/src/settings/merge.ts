import { Predicate } from "effect";

/**
 * A plain string-keyed record: what a settings patch merges, and what a plugin's `options` block
 * has to be. A Map, a typed array or a class instance is an object to `typeof` and not one of
 * these — `Object.freeze` alone does not tell them apart, and it throws on some of them.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
	Predicate.isObject(value) &&
	!Array.isArray(value) &&
	(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const copy = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(copy);
	return isRecord(value) ? merge({}, value) : value;
};

/** Null/undefined properties are absent, objects merge, and arrays replace. Never mutates inputs. */
export function merge<T extends object>(base: T, ...patches: ReadonlyArray<object | undefined>): T {
	const result = new Map<string, unknown>();
	for (const patch of [base, ...patches]) {
		if (patch === undefined) continue;
		for (const [key, value] of Object.entries(patch)) {
			if (value === null || value === undefined) continue;
			const previous = result.get(key);
			result.set(key, isRecord(previous) && isRecord(value) ? merge(previous, value) : copy(value));
		}
	}
	// Callers merge validated partial patches or typed runtime options onto a complete base.
	return Object.fromEntries(result) as T;
}

/** Normalize nullable properties before schema validation, without changing array positions. */
export const normalize = copy;
