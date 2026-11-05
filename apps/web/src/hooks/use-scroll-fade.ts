import { useLayoutEffect, type RefObject } from "react";

export function useScrollFade(viewport: RefObject<HTMLElement | null>) {
	useLayoutEffect(() => {
		const element = viewport.current;
		if (element === null) return;
		const update = () => {
			element.style.setProperty("--scroll-top", element.scrollTop > 1 ? "transparent" : "black");
			element.style.setProperty(
				"--scroll-bottom",
				element.scrollTop + element.clientHeight < element.scrollHeight - 1 ? "transparent" : "black",
			);
		};
		const resize = new ResizeObserver(update);
		const observe = () => {
			resize.disconnect();
			resize.observe(element);
			for (const child of element.children) resize.observe(child);
			update();
		};
		const mutations = new MutationObserver(observe);
		// Direct children only: their ResizeObserver entries already catch anything nested growing.
		mutations.observe(element, { childList: true });
		element.addEventListener("scroll", update, { passive: true });
		observe();
		return () => {
			resize.disconnect();
			mutations.disconnect();
			element.removeEventListener("scroll", update);
		};
	}, [viewport]);
}
