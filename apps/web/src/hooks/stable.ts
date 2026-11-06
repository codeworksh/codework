import { useInsertionEffect, useRef, useState } from "react";

/**
 * `fn` behind one identity for the component's life, so passing it never renders a memoized child
 * again. Call it from handlers and effects only: render would see the previous commit's `fn`.
 */
export function useStableCallback<Args extends ReadonlyArray<unknown>, Result>(
	fn: (...args: Args) => Result,
): (...args: Args) => Result {
	const latest = useRef(fn);
	// Before every layout effect of the commit, so a child's layout effect already calls this render's `fn`.
	useInsertionEffect(() => {
		latest.current = fn;
	});
	const [stable] = useState(
		() =>
			(...args: Args) =>
				latest.current(...args),
	);
	return stable;
}
