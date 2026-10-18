import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { useEffect, useMemo, useReducer } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import {
	type BundledLanguage,
	type BundledTheme,
	bundledLanguages,
	bundledLanguagesAlias,
	createHighlighter,
	type Highlighter,
} from "shiki";

import type { ThemeId } from "../../theme";

/**
 * The Shiki theme whose token colours go with each palette: the same theme where Shiki ships it,
 * else the closest in mood. Only token colours are used; the code block's background is ours.
 */
const SHIKI_THEMES: Record<ThemeId, BundledTheme> = {
	"tokyo-night": "tokyo-night",
	catppuccin: "catppuccin-mocha",
	"catppuccin-latte": "catppuccin-latte",
	gruvbox: "gruvbox-dark-medium",
	everforest: "everforest-dark",
	kanagawa: "kanagawa-wave",
	nord: "nord",
	"rose-pine": "rose-pine-dawn",
	"last-horizon": "horizon",
	white: "github-light",
	"flexoki-light": "vitesse-light",
	lupine: "one-light",
	"matte-black": "github-dark-default",
	vantablack: "min-dark",
	hackerman: "github-dark-high-contrast",
	lumon: "poimandres",
	ethereal: "one-dark-pro",
	miasma: "gruvbox-dark-soft",
	"osaka-jade": "vitesse-dark",
	"retro-82": "synthwave-84",
	ristretto: "monokai",
	solitude: "github-dark-dimmed",
};

type Root = ReturnType<Highlighter["codeToHast"]>;

/** A fence's language as Shiki knows it; undefined for none or one it has no grammar for. */
export function languageOf(name: string | undefined): BundledLanguage | undefined {
	const lower = name?.toLowerCase();
	return lower !== undefined && (lower in bundledLanguages || lower in bundledLanguagesAlias)
		? (lower as BundledLanguage)
		: undefined;
}

// One highlighter for the app, with grammars and themes loaded as code blocks ask for them.
let highlighter: Highlighter | undefined;
let creating: Promise<Highlighter> | undefined;
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

const notify = () => {
	for (const listener of listeners) listener();
};

function load(kind: "lang" | "theme", name: string) {
	const key = `${kind}:${name}`;
	if (loading.has(key)) return;
	creating ??= createHighlighter({ themes: [], langs: [] }).then((created) => (highlighter = created));
	const task = creating
		.then((ready) =>
			kind === "lang" ? ready.loadLanguage(name as BundledLanguage) : ready.loadTheme(name as BundledTheme),
		)
		.then(notify)
		.catch(() => undefined);
	loading.set(key, task);
}

/** Whether `code` can be highlighted right now; if not, loading starts and subscribers re-render. */
function ready(lang: BundledLanguage, theme: BundledTheme) {
	const hasLang = highlighter?.getLoadedLanguages().includes(lang) === true;
	const hasTheme = highlighter?.getLoadedThemes().includes(theme) === true;
	if (!hasLang) load("lang", lang);
	if (!hasTheme) load("theme", theme);
	return hasLang && hasTheme;
}

/**
 * `code` highlighted for the palette, as Shiki's hast tree, or undefined until its grammar and
 * theme have loaded (the caller shows the plain text meanwhile). Synchronous once loaded, so a
 * streaming block re-highlights in the same render as its text changes, with nothing to flash.
 */
export function useHighlight(code: string, lang: BundledLanguage | undefined, theme: ThemeId): Root | undefined {
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		listeners.add(rerender);
		return () => {
			listeners.delete(rerender);
		};
	}, []);
	const shikiTheme = SHIKI_THEMES[theme];
	const available = lang !== undefined && ready(lang, shikiTheme);
	return useMemo(
		() => (available && lang !== undefined ? highlighter?.codeToHast(code, { lang, theme: shikiTheme }) : undefined),
		[available, code, lang, shikiTheme],
	);
}

const runtime = { Fragment, jsx, jsxs };

/** The highlighted lines alone: Shiki's own `pre` (and its background) is left out. */
export function HighlightedCode({ root }: { readonly root: Root }) {
	const pre = root.children[0];
	const code = pre?.type === "element" ? pre.children[0] : undefined;
	return code?.type === "element" ? toJsxRuntime(code, runtime) : toJsxRuntime(root, runtime);
}
