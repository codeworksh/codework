const timing = { duration: 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" };

/** A file's body: the clip under its header, around the diff. */
const bodyOf = (section: Element) => section.lastElementChild;

/** How much of a file's body shows in the list, and how far the body is scrolled under its header. */
interface Shown {
	readonly height: number;
	readonly offset: number;
}

export function shown(list: HTMLElement, section: Element): Shown {
	const body = bodyOf(section);
	const header = section.firstElementChild?.getBoundingClientRect();
	if (body === null || header === undefined) return { height: 0, offset: 0 };
	// A slide still running would be measured mid-way: toggled again, a file starts over from its end.
	for (const motion of body.getAnimations({ subtree: true })) motion.cancel();
	// The diff itself is measured: around it, a body skipped until now stands at a guessed height.
	const height = body.firstElementChild?.firstElementChild?.getBoundingClientRect().height ?? 0;
	const start = body.getBoundingClientRect().top;
	const top = Math.max(start, header.bottom);
	return {
		height: Math.max(0, Math.min(start + height, list.getBoundingClientRect().bottom) - top),
		offset: top - start,
	};
}

/**
 * Slides a file's body open or shut. Only the part in view travels, so a diff of any length moves the
 * same short way, and files out of view do not move at all. The keyframes hold `visibility`, which
 * keeps a body just folded drawn until it is shut.
 */
export function slide(section: Element, { height, offset }: Shown, to: "open" | "shut") {
	const body = bodyOf(section);
	if (!(body instanceof HTMLElement) || height === 0) return;
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	const frames = [
		{ visibility: "visible", height: "0px" },
		{ visibility: "visible", height: `${height}px` },
	];
	body.animate(to === "open" ? frames : frames.reverse(), timing);
	// The diff stays drawn while its body shuts. Shut from a stuck header, the lines in view stay where
	// they are while the file's start goes to the top.
	const held = `translateY(${-offset}px)`;
	body.firstElementChild?.animate({ contentVisibility: ["visible", "visible"], transform: [held, held] }, timing);
}

/** The file at the top of the list. */
export const topOf = (list: HTMLElement) =>
	Math.max(
		0,
		Array.from(list.children).findLastIndex(
			(section) => section instanceof HTMLElement && section.offsetTop <= list.scrollTop + 1,
		),
	);

/** The files in view. */
export function inView(list: HTMLElement): ReadonlyArray<HTMLElement> {
	const end = list.scrollTop + list.clientHeight;
	const sections: Array<HTMLElement> = [];
	for (let at = topOf(list); at < list.children.length; at++) {
		const section = list.children[at];
		if (!(section instanceof HTMLElement) || section.offsetTop >= end) break;
		sections.push(section);
	}
	return sections;
}
