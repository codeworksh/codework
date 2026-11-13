import { useAtomValue } from "@effect/atom-react";
import { parsePatchFiles, type VirtualFileMetrics, Virtualizer } from "@pierre/diffs";
import { FileDiff, useVirtualizer, VirtualizerContext, WorkerPoolContext } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { Atom } from "effect/reactivity";
import { memo, type ReactNode, type RefObject, useLayoutEffect, useMemo, useState } from "react";

import { themeAtom } from "../../theme";

export type DiffStyle = "unified" | "split";

const STYLE_KEY = "codework-diff-style";

function savedStyle(): DiffStyle {
	try {
		return localStorage.getItem(STYLE_KEY) === "unified" ? "unified" : "split";
	} catch {
		// Storage can be unavailable; the default applies.
		return "split";
	}
}

/** Inline or split, saved per device. */
export const diffStyleAtom = Atom.writable<DiffStyle, DiffStyle>(savedStyle, (ctx, style) => {
	try {
		localStorage.setItem(STYLE_KEY, style);
	} catch {
		// The choice still applies for this run.
	}
	ctx.setSelf(style);
}).pipe(Atom.keepAlive);

// Both are highlighted at once, so a theme switch only flips which one shows.
const themes = { light: "pierre-light", dark: "pierre-dark" } as const;

/**
 * Past this many characters on a side, a diff gets no word diff and no highlighting: both would hold
 * up its workers for seconds.
 */
const LARGE = 500_000;

/** Past this many lines a diff draws only the rows near the view: below, drawing them all costs less. */
const VIRTUAL = 200;

const plainOptions = { lineDiffType: "none", maxLineDiffLength: 0, tokenizeMaxLineLength: 1 } as const;

/** A pool renders with its own options over the viewer's, so a large diff has a plain pool of its own. */
const makePool = (plain: boolean) => {
	const pool = new WorkerPoolManager(
		{ workerFactory: () => new DiffsWorker(), poolSize: plain ? 1 : 2 },
		{ theme: themes, lineDiffType: "word-line", ...(plain ? plainOptions : {}) },
	);
	void pool.initialize();
	return pool;
};

let pools: { readonly highlighted: WorkerPoolManager; readonly plain: WorkerPoolManager } | undefined;

/** A diff line's height, in pixels. */
export const LINE = 19;

const metrics: VirtualFileMetrics = { hunkLineCount: 50, lineHeight: LINE, diffHeaderHeight: 0, spacing: 8 };

const unsafeCSS = `
:host {
	--diffs-light-bg: var(--cw-frame);
	--diffs-dark-bg: var(--cw-frame);
	--diffs-font-family: var(--font-mono);
	--diffs-header-font-family: var(--font-sans);
	--diffs-font-size: 12px;
	--diffs-line-height: ${LINE}px;
}
`;

/** The worker pool caches highlights by key, so the key changes with the patch. */
const keyOf = (patch: string) => {
	let hash = 0x811c9dc5;
	for (let index = 0; index < patch.length; index++) hash = Math.imul(hash ^ patch.charCodeAt(index), 0x01000193);
	return `changes:${patch.length}:${(hash >>> 0).toString(36)}`;
};

/**
 * Highlights the diffs inside off the main thread, and draws the long ones by the rows near `scroller`'s
 * view. The workers and what they highlighted are kept for the app's run: a diff shown again, as when
 * its frame returns with its workspace, comes back in colour.
 */
export function DiffPool({
	scroller,
	children,
}: {
	readonly scroller: RefObject<HTMLElement | null>;
	readonly children: ReactNode;
}) {
	const [pool] = useState(() => (pools ??= { highlighted: makePool(false), plain: makePool(true) }));
	const [virtualizer] = useState(() => new Virtualizer());
	useLayoutEffect(() => {
		const list = scroller.current;
		if (list === null) return;
		virtualizer.setup(list);
		return () => virtualizer.cleanUp();
	}, [scroller, virtualizer]);
	return (
		<WorkerPoolContext.Provider value={pool.highlighted}>
			<VirtualizerContext.Provider value={virtualizer}>{children}</VirtualizerContext.Provider>
		</WorkerPoolContext.Provider>
	);
}

/** One file's patch; the file header is the caller's. */
export const Diff = memo(function Diff({ patch, style }: { readonly patch: string; readonly style: DiffStyle }) {
	const theme = useAtomValue(themeAtom);
	const virtualizer = useVirtualizer();
	const fileDiff = useMemo(() => parsePatchFiles(patch, keyOf(patch))[0]?.files[0], [patch]);
	const large = useMemo(
		() =>
			fileDiff !== undefined &&
			Math.max(fileDiff.deletionLines.join("").length, fileDiff.additionLines.join("").length) > LARGE,
		[fileDiff],
	);
	const virtual = fileDiff !== undefined && fileDiff.additionLines.length + fileDiff.deletionLines.length > VIRTUAL;
	const options = useMemo(
		() =>
			({
				theme: themes,
				themeType: theme,
				diffStyle: style,
				diffIndicators: "bars",
				lineDiffType: "word-line",
				overflow: "wrap",
				disableFileHeader: true,
				// Patches carry no whole files, so the lines between hunks cannot be expanded.
				hunkSeparators: "line-info-basic",
				unsafeCSS,
				...(large ? plainOptions : {}),
			}) as const,
		[theme, style, large],
	);
	if (fileDiff === undefined || fileDiff.hunks.length === 0)
		return <p className="px-4 py-3 text-xs text-ink-muted">No Text Changes</p>;
	// Keyed, as a drawn diff keeps the kind it was made as.
	const diff = <FileDiff key={String(virtual)} fileDiff={fileDiff} options={options} metrics={metrics} />;
	return (
		<VirtualizerContext.Provider value={virtual ? virtualizer : undefined}>
			{large ? <WorkerPoolContext.Provider value={pools?.plain}>{diff}</WorkerPoolContext.Provider> : diff}
		</VirtualizerContext.Provider>
	);
});
