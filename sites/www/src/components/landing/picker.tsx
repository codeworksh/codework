import { ChevronLeft, ChevronRight, Paintbrush, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { HINT_KEY, OPEN_PICKER_EVENT, THEMES, previewOf, readTheme, switchTheme } from "./theme";

/** The card slant: a 2.5% lean, the top edge shifted right of the bottom. */
const PARALLELOGRAM = "polygon(2.5% 0%, 100% 0%, 97.5% 100%, 0% 100%)";
/** The same slant inset by a border width, so the border's slanted edges stay parallel. */
const inset = (b: string) =>
	`polygon(calc(2.5% + ${b}) ${b}, calc(100% - ${b}) ${b}, calc(97.5% - ${b}) calc(100% - ${b}), ${b} calc(100% - ${b}))`;
const CARD = "w-[min(68vw,46rem)] sm:w-[min(72vw,46rem)]";

const NARROW = "(max-width: 639.98px)";
function useNarrow() {
	return useSyncExternalStore(
		(change) => {
			const query = window.matchMedia(NARROW);
			query.addEventListener("change", change);
			return () => query.removeEventListener("change", change);
		},
		() => window.matchMedia(NARROW).matches,
		() => false,
	);
}

/** True while the keystroke belongs to a field someone is typing into. */
const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement &&
	(target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Wraps an index into the theme list. */
const wrap = (i: number) => (i + THEMES.length) % THEMES.length;

/** The theme picker: T opens a deck of theme previews; arrows walk it, Enter takes one, Esc closes. */
export function Picker() {
	const narrow = useNarrow();
	const [open, setOpen] = useState(false);
	const [index, setIndex] = useState(0);
	const [hint, setHint] = useState(false);
	const dialog = useRef<HTMLDivElement>(null);
	const restoreFocus = useRef<HTMLElement | null>(null);
	const indexRef = useRef(0);
	const swipe = useRef({ id: -1, from: 0, moved: 0 });

	const hintSeen = useCallback(() => {
		setHint(false);
		try {
			localStorage.setItem(HINT_KEY, "true");
		} catch {
			// Without storage the hint simply shows again next visit.
		}
	}, []);

	const openPicker = useCallback(() => {
		const at = Math.max(
			0,
			THEMES.findIndex((t) => t.id === readTheme()),
		);
		indexRef.current = at;
		setIndex(at);
		restoreFocus.current = document.activeElement as HTMLElement | null;
		setOpen(true);
		hintSeen();
	}, [hintSeen]);

	const close = useCallback(() => {
		setOpen(false);
		restoreFocus.current?.focus({ preventScroll: true });
	}, []);

	const step = useCallback((delta: number) => {
		setIndex((at) => (indexRef.current = wrap(at + delta)));
	}, []);

	const choose = useCallback(() => {
		const next = THEMES[indexRef.current]!;
		if (next.id === readTheme()) return close();
		// The picker is a named layer in the wipe, so it must be gone before the browser's second
		// snapshot, or the browser drops the whole transition; hence the synchronous close.
		switchTheme(next.id, () => flushSync(close), true);
	}, [close]);

	// T toggles the picker from anywhere, unless someone is typing or holding a modifier.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== "t" || event.metaKey || event.ctrlKey || event.altKey || typing(event.target))
				return;
			event.preventDefault();
			if (open) close();
			else openPicker();
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener(OPEN_PICKER_EVENT, openPicker);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener(OPEN_PICKER_EVENT, openPicker);
		};
	}, [open, openPicker, close]);

	// The hint appears once, a moment after arrival, until the picker is opened or it is dismissed.
	useEffect(() => {
		let seen = true;
		try {
			seen = localStorage.getItem(HINT_KEY) === "true";
		} catch {
			// No storage: stay quiet rather than show the hint on every visit.
		}
		if (seen) return;
		const timer = window.setTimeout(() => setHint(true), 1600);
		return () => window.clearTimeout(timer);
	}, []);

	// Decode the previews around the front card so stepping never waits on the network.
	const warmed = useRef(new Set<string>());
	useEffect(() => {
		if (!open) return;
		for (let d = -2; d <= 2; d++) {
			const id = THEMES[wrap(index + d)]!.id;
			if (warmed.current.has(id)) continue;
			warmed.current.add(id);
			const img = new Image();
			img.decoding = "async";
			img.src = previewOf(id);
		}
	}, [open, index]);

	useEffect(() => {
		if (!open) return;
		dialog.current?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "ArrowLeft") step(-1);
			else if (event.key === "ArrowRight") step(1);
			else if (event.key === "Enter") choose();
			else if (event.key === "Escape") close();
			else return;
			event.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, step, choose, close]);

	if (!open) {
		if (!hint) return null;
		return (
			<div role="status" className="notice-in fixed top-17 right-4 z-60 w-72">
				<div className="relative border border-border-subtle bg-surface">
					<button
						type="button"
						onClick={openPicker}
						className="flex w-full items-start gap-3 p-4 pr-10 text-left transition-colors hover:bg-surface-2"
					>
						<Paintbrush className="mt-0.5 size-5 shrink-0 text-brand" />
						<span>
							<span className="block font-sans text-sm font-medium text-text">Change the theme</span>
							<span className="mt-1 block text-[13px] leading-relaxed text-text-secondary">
								Press <kbd className="border border-border-strong px-1 text-[12px]">T</kbd>, or tap here.
							</span>
						</span>
					</button>
					<button
						type="button"
						aria-label="Dismiss"
						onClick={hintSeen}
						className="absolute top-2 right-2 flex size-8 items-center justify-center text-text-muted transition-colors hover:text-text"
					>
						<X className="size-4" />
					</button>
				</div>
			</div>
		);
	}

	const current = THEMES[index]!;
	const aspect = narrow ? "4 / 5" : "1800 / 1012";

	return (
		<>
			<div aria-hidden="true" className="fixed inset-0 z-70 bg-black/55 backdrop-blur-xs" />
			<div
				ref={dialog}
				role="dialog"
				aria-modal="true"
				aria-label="Theme picker"
				tabIndex={-1}
				// A touch swipe walks the deck; one that has travelled is not a tap, so its click is swallowed.
				onPointerDown={(event) => {
					if (event.pointerType === "touch")
						swipe.current = { id: event.pointerId, from: event.clientX, moved: 0 };
				}}
				onPointerMove={(event) => {
					if (event.pointerId === swipe.current.id) swipe.current.moved = event.clientX - swipe.current.from;
				}}
				onPointerUp={(event) => {
					const drag = swipe.current;
					if (event.pointerId !== drag.id) return;
					swipe.current = { ...drag, id: -1 };
					if (Math.abs(drag.moved) > 44) step(drag.moved < 0 ? 1 : -1);
				}}
				onClickCapture={(event) => {
					if (Math.abs(swipe.current.moved) <= 44) return;
					swipe.current.moved = 0;
					event.preventDefault();
					event.stopPropagation();
				}}
				className="fixed inset-0 z-70 flex touch-none flex-col items-center justify-center outline-none"
				style={{ viewTransitionName: "theme-picker" }}
			>
				<div aria-hidden="true" onClick={close} className="absolute inset-0" />

				<div className="pointer-events-none relative flex w-full items-center justify-center">
					{THEMES.map((theme, i) => {
						// Signed distance from the front card, wrapped so the fan is symmetric.
						const raw = i - index;
						const half = THEMES.length / 2;
						const offset = raw > half ? raw - THEMES.length : raw < -half ? raw + THEMES.length : raw;
						const depth = Math.abs(offset);
						if (depth > 2) return null;
						// Neighbours tuck in behind the front card; the first term offsets the front card's larger scale.
						const shift = offset === 0 ? 0 : Math.sign(offset) * (6 + depth * 12);
						return (
							<div
								key={theme.id}
								aria-hidden={offset !== 0}
								className={`absolute ${CARD}`}
								style={{
									transform: `translateX(${shift}%) scale(${depth === 0 ? 1 : 0.88})`,
									zIndex: 10 - depth,
								}}
							>
								<button
									type="button"
									tabIndex={-1}
									aria-label={offset === 0 ? `Use ${theme.name}` : `Show ${theme.name}`}
									onClick={() => (offset === 0 ? choose() : step(offset))}
									className="pointer-events-auto block w-full cursor-pointer [--card-dim:0.55] hover:[--card-dim:0.78]"
								>
									<div
										className={`shadow-2xl ${depth === 0 ? "bg-brand" : "bg-zinc-500"}`}
										style={{ clipPath: PARALLELOGRAM }}
									>
										<div className="bg-black" style={{ clipPath: inset(depth === 0 ? "3px" : "1px") }}>
											<img
												src={previewOf(theme.id)}
												alt={`${theme.name} theme preview`}
												width={1800}
												height={1012}
												draggable={false}
												className="w-full object-cover select-none"
												style={{
													aspectRatio: aspect,
													filter: depth === 0 ? undefined : "brightness(var(--card-dim))",
												}}
											/>
										</div>
									</div>
								</button>
							</div>
						);
					})}
					{/* Gives the absolutely placed deck its height. */}
					<div className={`invisible ${CARD}`} style={{ aspectRatio: aspect }} />
				</div>

				{/* The name wears its own theme's colours, so the label previews the palette too. */}
				<button
					type="button"
					tabIndex={-1}
					aria-label={`Use ${current.name}`}
					onClick={choose}
					className="relative mt-1.5 cursor-pointer px-4 py-3.5 transition-[filter] hover:brightness-125"
				>
					<span
						data-theme={current.id}
						className="block font-sans text-2xl font-semibold tracking-tight"
						style={{
							color: current.light ? "var(--t-bg)" : "var(--t-text)",
							WebkitTextStroke: `2px ${current.light ? "var(--t-text)" : "var(--t-bg)"}`,
							paintOrder: "stroke fill",
						}}
					>
						{current.name}
					</span>
				</button>

				{(
					[
						[-1, "Previous theme", ChevronLeft, "left-3 sm:left-6"],
						[1, "Next theme", ChevronRight, "right-3 sm:right-6"],
					] as const
				).map(([delta, label, Icon, side]) => (
					<button
						key={label}
						type="button"
						aria-label={label}
						onClick={(event) => {
							event.stopPropagation();
							step(delta);
						}}
						className={`absolute top-1/2 flex size-11 -translate-y-1/2 cursor-pointer items-center justify-center border border-border-subtle bg-bg text-text transition-colors hover:bg-surface-2 ${side}`}
					>
						<Icon className="size-5" />
					</button>
				))}
			</div>
		</>
	);
}
