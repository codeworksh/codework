import { useEffect } from "react";

interface Scrollbar {
	animation: Animation | undefined;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/** Fade native thumbs without rerendering, changing their width, or restarting on every scroll event. */
export function useScrollbars() {
	useEffect(() => {
		const active = new Map<HTMLElement, Scrollbar>();
		const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
		const fade = (element: HTMLElement, state: Scrollbar, color: string, duration: number) => {
			// Read before cancelling so a new scroll can reverse an unfinished fade.
			const from = getComputedStyle(element).scrollbarColor;
			state.animation?.cancel();
			const animation = element.animate([{ scrollbarColor: from }, { scrollbarColor: color }], {
				duration: reducedMotion.matches ? 0 : duration,
				easing: "cubic-bezier(0.23, 1, 0.32, 1)",
				fill: "forwards",
			});
			state.animation = animation;
			return animation;
		};
		const scroll = (event: Event) => {
			const element = event.target;
			if (!(element instanceof HTMLElement)) return;
			const state = active.get(element) ?? { animation: undefined, timer: undefined };
			if (state.timer === undefined) {
				// Native scrollbar keyframes interpolate concrete RGBA colors; unresolved variables jump.
				const color = getComputedStyle(element).getPropertyValue("--cw-scrollbar").trim();
				fade(element, state, `${color} transparent`, 125);
			}
			clearTimeout(state.timer);
			state.timer = setTimeout(() => {
				state.timer = undefined;
				const animation = fade(element, state, "transparent transparent", 250);
				animation.onfinish = () => {
					animation.cancel();
					active.delete(element);
				};
			}, 900);
			active.set(element, state);
		};
		// Scroll does not bubble; capture also covers nested code blocks and portalled menus.
		document.addEventListener("scroll", scroll, { capture: true, passive: true });
		return () => {
			document.removeEventListener("scroll", scroll, true);
			for (const state of active.values()) {
				clearTimeout(state.timer);
				state.animation?.cancel();
			}
		};
	}, []);
}
