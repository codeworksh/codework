/**
 * Keeps `previous`'s object for each item of a new read that `same` finds unchanged, matched by `key`.
 * A read decodes every item anew; kept objects let a memoized view skip the items that did not change.
 */
export const keeper = <T>(previous: Iterable<T>, key: (item: T) => string, same: (a: T, b: T) => boolean) => {
	const byKey = new Map<string, T>();
	for (const item of previous) byKey.set(key(item), item);
	return (item: T): T => {
		const before = byKey.get(key(item));
		return before !== undefined && same(before, item) ? before : item;
	};
};
