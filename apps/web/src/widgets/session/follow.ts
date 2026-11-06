import type { AnchoredEndSpaceConfig, LegendListRef, MaintainScrollAtEndOptions } from "@legendapp/list/react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/** The anchored prompt's distance from the top of the viewport. */
const ANCHOR_OFFSET = 20;
/** How far from the end still counts as at it. */
const END_BAND = 40;

const END = {
	animated: false,
	on: { dataChange: true, footerLayout: false, itemLayout: true, layout: true },
} as const satisfies MaintainScrollAtEndOptions;
const END_SMOOTH = { ...END, animated: true } as const satisfies MaintainScrollAtEndOptions;

const CANCEL = Object.freeze({});

const PROMPT_RISE_MS = 560;
const PROMPT_REVEAL_MS = 320;
const PROMPT_FADE_MS = 480;
const PROMPT_RISE_FROM = 0.3;

const isAtEnd = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= END_BAND;

/** Whether the transcript keeps the live end in view. `atEnd` only matters once released. */
type Follow = { readonly mode: "following" } | { readonly mode: "released"; readonly atEnd: boolean };
type FollowEvent = "navigated" | "followEnd" | "reachedEnd" | "leftEnd";

const FOLLOWING: Follow = { mode: "following" };

function transition(state: Follow, event: FollowEvent): Follow {
	switch (event) {
		case "navigated":
			return state.mode === "released" ? state : { mode: "released", atEnd: true };
		case "followEnd":
			return FOLLOWING;
		case "reachedEnd":
			// Navigating away while still at the end stays released until the list reports leaving and
			// returning, so a scroll key at the end cannot re-arm.
			return state.mode === "released" && !state.atEnd ? FOLLOWING : state;
		case "leftEnd":
			// While following, the list leaves the end band for a frame on every streamed chunk before
			// the follow scroll catches up.
			return state.mode === "released" && state.atEnd ? { mode: "released", atEnd: false } : state;
	}
}

/** The follow mode, read by scroll listeners at event time and by render through useSyncExternalStore. */
function followStore() {
	let follow = FOLLOWING;
	const listeners = new Set<() => void>();
	return {
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		read: () => follow,
		dispatch: (event: FollowEvent) => {
			const before = follow;
			follow = transition(before, event);
			if (follow !== before) for (const listener of listeners) listener();
			return { before, after: follow };
		},
	};
}

/** One reader attempt to move the transcript. */
type Navigation =
	| { readonly source: "wheel" | "key"; readonly up: boolean }
	| { readonly source: "pointer"; readonly onScrollbar: boolean }
	| { readonly source: "touch" | "scroll" };

/**
 * Whether a navigation can carry the view away from the live end. Downward input counts only outside
 * the end band: streaming growth leaves it for a frame, and a gesture then must not release follow.
 */
function releases(navigation: Navigation, el: HTMLElement) {
	const scrollsUp = el.scrollTop > 0;
	switch (navigation.source) {
		case "wheel":
			return navigation.up && scrollsUp;
		case "key":
			return navigation.up ? scrollsUp : !isAtEnd(el);
		case "pointer":
			return navigation.onScrollbar ? scrollsUp : !isAtEnd(el);
		case "touch":
			return !isAtEnd(el);
		case "scroll":
			return true;
	}
}

/** Whether a wheel at `target` scrolls the transcript itself rather than a scroller nested in it. */
function scrollsTranscript(target: EventTarget | null, el: HTMLElement, deltaY: number) {
	if (!(target instanceof Element) || !el.contains(target) || deltaY === 0) return false;
	for (let node: Element | null = target; node !== null && node !== el; node = node.parentElement) {
		const style = getComputedStyle(node);
		if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;
		const canScroll = deltaY < 0 ? node.scrollTop > 0 : node.scrollTop < node.scrollHeight - node.clientHeight;
		if (canScroll || style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none") return false;
	}
	return true;
}

const UP_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);
const DOWN_KEYS = new Set(["PageDown", "End", "ArrowDown", " "]);

/** Turns the scroller's input listeners into one navigation signal, for as long as it is mounted. */
function attachViewport(el: HTMLElement, navigate: (navigation: Navigation) => void) {
	let holds = 0;
	const wheel = (event: WheelEvent) => {
		if (!event.ctrlKey && scrollsTranscript(event.target, el, event.deltaY))
			navigate({ source: "wheel", up: event.deltaY < 0 });
	};
	const touch = () => navigate({ source: "touch" });
	// Scrollbar drags are the only pointerdowns whose target is the scroller itself rather than a row.
	const pointer = (event: PointerEvent) => navigate({ source: "pointer", onScrollbar: event.target === el });
	const key = (event: KeyboardEvent) => {
		if (event.target !== el || event.altKey || event.ctrlKey || event.metaKey) return;
		const up = UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey);
		if (up || DOWN_KEYS.has(event.key)) navigate({ source: "key", up });
	};
	// Scrolls no listener above hears still count when they move up and away from the end.
	let baseline = { top: el.scrollTop, height: el.scrollHeight };
	const scroll = () => {
		const next = { top: el.scrollTop, height: el.scrollHeight };
		if (holds > 0 || next.height < baseline.height || next.top > baseline.top) {
			baseline = next;
		} else if (next.top < baseline.top - 1) {
			baseline = next;
			if (!isAtEnd(el)) navigate({ source: "scroll" });
		} else {
			// A slow scroll can move under a pixel per event; let those moves add up.
			baseline = { top: baseline.top, height: next.height };
		}
	};
	el.addEventListener("scroll", scroll, { passive: true });
	el.addEventListener("wheel", wheel, { passive: true });
	el.addEventListener("touchmove", touch, { passive: true });
	el.addEventListener("pointerdown", pointer, { passive: true });
	el.addEventListener("keydown", key);
	return {
		el,
		/** Marks our own scrolling so the upward scroll it causes is not read as the reader's. */
		hold: () => {
			holds += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				holds -= 1;
			};
		},
		dispose: () => {
			el.removeEventListener("scroll", scroll);
			el.removeEventListener("wheel", wheel);
			el.removeEventListener("touchmove", touch);
			el.removeEventListener("pointerdown", pointer);
			el.removeEventListener("keydown", key);
		},
	};
}

/** Fades a freshly sent prompt in while sliding it from the upper viewport into its top anchor. */
function riseIntoAnchor(scroller: HTMLElement | undefined, promptId: string) {
	if (scroller === undefined) return undefined;
	const row = scroller.querySelector<HTMLElement>(`[data-prompt-anchor="${CSS.escape(promptId)}"]`);
	if (row === null || typeof row.animate !== "function") return undefined;
	if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return undefined;
	const view = scroller.getBoundingClientRect();
	const dy = view.top + view.height * PROMPT_RISE_FROM - row.getBoundingClientRect().top;
	if (dy <= 1) return undefined;
	const animation = row.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
		duration: PROMPT_RISE_MS,
		easing: "cubic-bezier(0.22, 1, 0.36, 1)",
	});
	const fade = row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: PROMPT_FADE_MS, easing: "ease-out" });
	const turn = row.closest<HTMLElement>(".transcript-turn");
	let revealTimer: ReturnType<typeof setTimeout> | undefined;
	turn?.setAttribute("data-prompt-rise", "rising");
	animation.onfinish = () => {
		turn?.setAttribute("data-prompt-rise", "revealing");
		revealTimer = setTimeout(() => turn?.removeAttribute("data-prompt-rise"), PROMPT_REVEAL_MS);
	};
	return () => {
		animation.cancel();
		fade.cancel();
		clearTimeout(revealTimer);
		turn?.removeAttribute("data-prompt-rise");
	};
}

/**
 * Keeps the transcript following its live end and lets the reader scroll away: scrolling up
 * detaches it, scrolling back to the end re-attaches. A new prompt is anchored to the top of the
 * viewport (anchored end space) until its reply reaches the composer; the end follows it from there.
 */
export function useFollow({
	lastUserId,
	anchored,
	rise,
	running,
	inset,
	anchorIndex,
}: {
	readonly lastUserId: string | undefined;
	/** On mount: whether the latest prompt opens anchored. */
	readonly anchored: boolean;
	/** On mount: whether the latest prompt rises into its anchor. */
	readonly rise: boolean;
	readonly running: boolean;
	/** The composer overlay's height. */
	readonly inset: number;
	/** Where a prompt's turn sits in the list, or -1. */
	readonly anchorIndex: (promptId: string) => number;
}) {
	const list = useRef<LegendListRef | null>(null);
	const viewport = useRef<ReturnType<typeof attachViewport>>(undefined);
	const [store] = useState(followStore);
	const following = useSyncExternalStore(store.subscribe, store.read).mode === "following";
	const [settled, setSettled] = useState(false);
	const [anchor, setAnchor] = useState(() => (anchored ? (lastUserId ?? null) : null));
	// A prompt that rises stays hidden until its anchor is in place.
	const [rising, setRising] = useState(() => (rise ? lastUserId : undefined));
	const [seenUserId, setSeenUserId] = useState(lastUserId);
	if (seenUserId !== lastUserId) {
		setSeenUserId(lastUserId);
		if (lastUserId !== undefined) {
			setAnchor(lastUserId);
			setRising(lastUserId);
		}
	}
	// A new prompt follows its reply, wherever the reader was.
	useLayoutEffect(() => {
		if (lastUserId !== undefined) store.dispatch("followEnd");
	}, [store, lastUserId]);

	const anchorSize = useRef<number | undefined>(undefined);
	const positioned = useRef<string | null>(null);
	const cancelRise = useRef<() => void>(undefined);
	useEffect(() => () => cancelRise.current?.(), []);

	const toEnd = () => requestAnimationFrame(() => void list.current?.scrollToEnd({ animated: false }));
	const releaseAnchor = () => {
		anchorSize.current = undefined;
		setAnchor(null);
		toEnd();
	};
	const landed = (promptId: string) => {
		if (rising !== promptId) return;
		cancelRise.current?.();
		cancelRise.current = riseIntoAnchor(viewport.current?.el, promptId);
		setRising(undefined);
	};

	const index = anchor === null ? -1 : anchorIndex(anchor);
	// Read in render instead of the config, whose callbacks write refs, so the compiler keeps the hook.
	const anchoring = anchor !== null && index !== -1;
	const anchoredEndSpace: AnchoredEndSpaceConfig | undefined = !anchoring
		? undefined
		: {
				anchorIndex: index,
				anchorOffset: ANCHOR_OFFSET,
				onReady: ({ anchorIndex: ready, size }) => {
					anchorSize.current = size;
					if (ready === undefined || positioned.current === anchor) return;
					positioned.current = anchor;
					// Its reply already reaches the composer: the end follows it instead.
					if (following && size <= inset) {
						releaseAnchor();
						requestAnimationFrame(() => landed(anchor));
						return;
					}
					const release = viewport.current?.hold() ?? (() => {});
					void list.current
						?.scrollToIndex({ index: ready, viewPosition: 0, viewOffset: ANCHOR_OFFSET, animated: false })
						.then(() => {
							release();
							landed(anchor);
						});
				},
				onSizeChanged: (size) => {
					anchorSize.current = size;
					if (positioned.current === anchor && store.read().mode === "following" && size <= inset) releaseAnchor();
				},
			};

	const navigate = (navigation: Navigation) => {
		const el = viewport.current?.el;
		if (el === undefined || !releases(navigation, el)) return;
		if (store.dispatch("navigated").before.mode !== "following") return;
		// A new imperative scroll cancels the list's queued ones; a missing item cancels without moving.
		void list.current?.scrollToItem({ item: CANCEL, animated: false });
		// A smooth scroll already under way keeps running in the browser; writing its position halts it.
		const top = el.scrollTop;
		el.scrollTop = top;
	};
	const ref = (instance: LegendListRef | null) => {
		list.current = instance;
		if (instance === null) return;
		const attached = attachViewport(instance.getScrollableNode(), navigate);
		viewport.current = attached;
		return () => {
			attached.dispose();
			if (viewport.current === attached) viewport.current = undefined;
			list.current = null;
		};
	};

	const onScroll = () => {
		const el = viewport.current?.el;
		if (el === undefined) return;
		const { before, after } = store.dispatch(isAtEnd(el) ? "reachedEnd" : "leftEnd");
		// Back at the end of a reply that outgrew its anchor: follow the end again.
		if (
			after !== before &&
			after.mode === "following" &&
			anchorSize.current !== undefined &&
			anchorSize.current <= inset
		)
			releaseAnchor();
	};

	// The list doesn't follow its footer, so a taller composer would cover the last rows.
	const followedInset = useRef(inset);
	useLayoutEffect(() => {
		const grew = inset > followedInset.current;
		followedInset.current = inset;
		if (grew && anchoredEndSpace === undefined && store.read().mode === "following") toEnd();
	});

	const smooth = running && settled && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
	return {
		ref,
		onScroll,
		onLoad: () => setSettled(true),
		/** Laid out and scrolled into place: before this the list is measuring and may still move. */
		settled,
		anchoredEndSpace,
		maintainScrollAtEnd: anchoring || !following ? false : smooth ? END_SMOOTH : END,
		/** The prompt hidden until it rises into its anchor. */
		pending: anchor !== null && rising === anchor ? rising : undefined,
	};
}
