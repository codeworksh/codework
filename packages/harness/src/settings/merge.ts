import { Predicate } from "effect";

/** Merge data objects only; executable runtime objects keep their identity. */
const dataObject = (value: unknown): value is Record<string, unknown> =>
	Predicate.isObject(value) &&
	!Array.isArray(value) &&
	(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const copy = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(copy);
	return dataObject(value) ? merge({}, value) : value;
};

/** Null/undefined properties are absent, objects merge, and arrays replace. Never mutates inputs. */
export function merge<T extends object>(base: T, ...patches: ReadonlyArray<object | undefined>): T {
	const result = new Map<string, unknown>();
	for (const patch of [base, ...patches]) {
		if (patch === undefined) continue;
		for (const [key, value] of Object.entries(patch)) {
			if (value === null || value === undefined) continue;
			const previous = result.get(key);
			result.set(key, dataObject(previous) && dataObject(value) ? merge(previous, value) : copy(value));
		}
	}
	// Callers merge validated partial patches or typed runtime options onto a complete base.
	return Object.fromEntries(result) as T;
}

/** Normalize nullable properties before schema validation, without changing array positions. */
export const normalize = copy;
