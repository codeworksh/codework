import { useEffect, useRef } from "react";

const KEY_MS = 58;
const KEY_JITTER = 60;
const WORD_PAUSE = 95;
const DELETE_MS = 27;
const HOLD_MS = 2100;
const TURN_MS = 420;

/** Types each phrase, holds it, and backspaces only as far as the next phrase differs. */
export function Typewriter({ phrases }: { phrases: readonly string[] }) {
	const text = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		const el = text.current;
		const host = el?.parentElement;
		if (!el || !host) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			el.textContent = phrases[0] ?? "";
			return;
		}

		const shared = (a: string, b: string) => {
			let i = 0;
			while (i < a.length && i < b.length && a[i] === b[i]) i++;
			return i;
		};
		// Hold the heading at its tallest phrase, so the copy below never moves as phrases change length.
		const block = el.closest<HTMLElement>("[data-typed-block]");
		const reserve = () => {
			if (!block) return;
			const shown = el.textContent;
			block.style.minHeight = "";
			let tallest = 0;
			for (const phrase of phrases) {
				el.textContent = phrase;
				tallest = Math.max(tallest, block.getBoundingClientRect().height);
			}
			el.textContent = shown;
			block.style.minHeight = `${Math.ceil(tallest)}px`;
		};
		reserve();
		window.addEventListener("resize", reserve);
		// Measured against the web font, once it has loaded.
		void document.fonts?.ready.then(reserve);

		let timer = 0;
		let index = 0;
		let length = 0;
		let deleting = false;
		let running = false;

		const step = () => {
			const phrase = phrases[index]!;
			const next = phrases[(index + 1) % phrases.length]!;
			el.textContent = phrase.slice(0, length);

			let wait = deleting
				? DELETE_MS
				: KEY_MS + Math.random() * KEY_JITTER + (phrase[length - 1] === " " ? WORD_PAUSE : 0);
			if (!deleting && length === phrase.length) {
				deleting = true;
				wait = HOLD_MS;
			} else if (deleting && length === shared(phrase, next)) {
				deleting = false;
				index = (index + 1) % phrases.length;
				wait = TURN_MS;
			} else {
				length += deleting ? -1 : 1;
			}
			host.dataset.typing = wait === HOLD_MS || wait === TURN_MS ? "0" : "1";
			timer = window.setTimeout(step, wait);
		};

		const observer = new IntersectionObserver(([entry]) => {
			if (entry?.isIntersecting && !running) {
				running = true;
				step();
			} else if (!entry?.isIntersecting) {
				running = false;
				window.clearTimeout(timer);
			}
		});
		observer.observe(host);
		return () => {
			observer.disconnect();
			window.clearTimeout(timer);
			window.removeEventListener("resize", reserve);
			if (block) block.style.minHeight = "";
		};
	}, [phrases]);

	return (
		<span data-typing="0">
			<span ref={text} />
			<span className="typed-caret" aria-hidden="true" />
		</span>
	);
}
