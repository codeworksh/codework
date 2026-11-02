import { ChevronLeft, ChevronRight } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

// 44px on touch screens, the smallest target a thumb hits reliably.
const arrow =
	"flex size-9 items-center justify-center border border-border-strong bg-surface text-text transition-[background-color,transform] duration-150 ease-out hover:bg-surface-2 active:scale-[0.96] pointer-coarse:size-11";

/** A full-bleed, snapping rail of `count` slides: which one is current, and a progress bar that tracks the scroll. */
export function useRail(count: number) {
	const rail = useRef<HTMLDivElement>(null);
	const thumb = useRef<HTMLDivElement>(null);
	const [index, setIndex] = useState(0);

	useEffect(() => {
		const el = rail.current;
		if (!el) return;
		const sync = () => {
			// The current slide is the one nearest the centre; on wide screens a neighbour can be mostly in view too.
			const centre = el.scrollLeft + el.clientWidth / 2;
			const slides = [...el.children] as HTMLElement[];
			const distance = (s: HTMLElement) => Math.abs(s.offsetLeft + s.clientWidth / 2 - centre);
			setIndex(slides.reduce((best, s, i) => (distance(s) < distance(slides[best]!) ? i : best), 0));

			// The rail is full-bleed, so its own scrollbar would span the window; this one sits in the content column.
			const bar = thumb.current;
			if (!bar) return;
			const reach = el.scrollWidth - el.clientWidth;
			const ratio = Math.min(1, el.clientWidth / el.scrollWidth);
			const progress = reach > 0 ? el.scrollLeft / reach : 0;
			bar.style.width = `${ratio * 100}%`;
			bar.style.transform = `translateX(${(progress * (1 - ratio) * 100) / ratio}%)`;
		};
		const sizes = new ResizeObserver(sync);
		sizes.observe(el);
		el.addEventListener("scroll", sync, { passive: true });
		return () => {
			sizes.disconnect();
			el.removeEventListener("scroll", sync);
		};
	}, []);

	const goTo = (i: number) => {
		const el = rail.current;
		const slide = el?.children[(i + count) % count] as HTMLElement | undefined;
		if (!el || !slide) return;
		el.scrollTo({ left: slide.offsetLeft - (el.clientWidth - slide.clientWidth) / 2 });
	};

	return { rail, thumb, index, goTo };
}

export const railClass = "rail flex snap-x snap-mandatory gap-4 overflow-x-auto motion-safe:scroll-smooth";

/** Dims every slide but the current one. */
export const slideClass = (current: boolean) =>
	`w-full shrink-0 snap-center transition-[opacity,filter] duration-300 ease-out ${current ? "" : "opacity-40 brightness-75"}`;

export function Arrows({ noun, onStep }: { noun: string; onStep: (step: 1 | -1) => void }) {
	return (
		<div className="flex gap-2">
			<button type="button" aria-label={`Previous ${noun}`} className={arrow} onClick={() => onStep(-1)}>
				<ChevronLeft className="size-5" />
			</button>
			<button type="button" aria-label={`Next ${noun}`} className={arrow} onClick={() => onStep(1)}>
				<ChevronRight className="size-5" />
			</button>
		</div>
	);
}

export function Progress({ thumb }: { thumb: RefObject<HTMLDivElement | null> }) {
	return (
		<div aria-hidden="true" className="mt-5 h-1.5 bg-border-subtle/50">
			<div ref={thumb} className="h-full bg-brand" />
		</div>
	);
}
