const intersecting = new Map<Element, boolean>();
let observer: IntersectionObserver | null = null;

function update(element: Element, visible: boolean) {
	const running = visible && document.visibilityState === "visible";
	(element as HTMLElement | SVGElement).style.setProperty("--visible-animation-state", running ? "running" : "paused");
}

function updateAll() {
	for (const [element, visible] of intersecting) update(element, visible);
}

/**
 * A ref callback that runs an element's animation only while it is on screen and its tab is shown, through
 * `--visible-animation-state`. Every observed element shares one IntersectionObserver.
 */
export function observeVisibleAnimation(element: HTMLElement | SVGElement | null) {
	if (element === null) return;
	update(element, false);
	if (observer === null) {
		document.addEventListener("visibilitychange", updateAll);
		observer = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (!intersecting.has(entry.target)) continue;
				intersecting.set(entry.target, entry.isIntersecting);
				update(entry.target, entry.isIntersecting);
			}
		});
	}
	intersecting.set(element, false);
	observer.observe(element);
	return () => {
		intersecting.delete(element);
		observer?.unobserve(element);
		if (intersecting.size > 0) return;
		observer?.disconnect();
		observer = null;
		document.removeEventListener("visibilitychange", updateAll);
	};
}
