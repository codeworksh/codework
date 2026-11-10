import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { observeElementSize } from "webwm/dom";

// After the observer's callback returns but before paint: webwm notes the returned id first, then the
// callback clears it, so the next change is reported too.
const beforePaint = (callback: FrameRequestCallback) => {
	queueMicrotask(() => callback(performance.now()));
	return 1;
};

/**
 * An element's size, laid out in the same frame it changes: the observer reports before paint and the
 * size is committed there. webwm's own hook waits a frame and React another, so when the sidebar
 * opens the frames would sit at their old width beside the moved content for two frames.
 */
export function useElementSize<T extends Element>() {
	const [element, setElement] = useState<T | null>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const ref = useCallback((node: T | null) => setElement(node), []);
	useEffect(() => {
		if (element === null) return;
		return observeElementSize(element, (next) => flushSync(() => setSize(next)), {
			scheduleFrame: beforePaint,
			cancelFrame: () => {},
		});
	}, [element]);
	return [ref, size] as const;
}
