import { useAtomValue } from "@effect/atom-react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, WorkerPoolContext } from "@pierre/diffs/react";
import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { Atom } from "effect/reactivity";
import { memo, type ReactNode, useMemo, useState } from "react";

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

// The pool renders with its own options, so they match the viewer's.
const poolOptions = { workerFactory: () => new DiffsWorker(), poolSize: 2 };
const highlighterOptions = { theme: themes, lineDiffType: "word-line" } as const;

/** A diff line's height, in pixels. */
export const LINE = 19;

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
 * Highlights the diffs inside off the main thread. The workers and what they highlighted are kept for
 * the app's run: a diff shown again, as when its frame returns with its workspace, comes back in colour.
 */
export function DiffPool({ children }: { readonly children: ReactNode }) {
	const [pool] = useState(() => getOrCreateWorkerPoolSingleton({ poolOptions, highlighterOptions }));
	return <WorkerPoolContext.Provider value={pool}>{children}</WorkerPoolContext.Provider>;
}

/** One file's patch; the file header is the caller's. */
export const Diff = memo(function Diff({ patch, style }: { readonly patch: string; readonly style: DiffStyle }) {
	const theme = useAtomValue(themeAtom);
	const fileDiff = useMemo(() => parsePatchFiles(patch, keyOf(patch))[0]?.files[0], [patch]);
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
			}) as const,
		[theme, style],
	);
	if (fileDiff === undefined || fileDiff.hunks.length === 0)
		return <p className="px-4 py-3 text-xs text-ink-muted">No text changes</p>;
	return <FileDiff fileDiff={fileDiff} options={options} />;
});
