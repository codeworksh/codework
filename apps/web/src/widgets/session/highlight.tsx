import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { memo, useEffect, useReducer, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { BundledLanguage, BundledTheme, CodeToHastOptions, Highlighter } from "shiki";

import type { ThemeId } from "../../theme";

/** Syntax colours follow the app's light or dark appearance. */
const SHIKI_THEMES: Record<ThemeId, BundledTheme> = {
	light: "github-light",
	dark: "github-dark-default",
};

type Root = ReturnType<Highlighter["codeToHast"]>;
/** One `span.line` of Shiki's hast tree. */
type Line = Extract<Root["children"][number], { type: "element" }>;

/**
 * A fence's language, lower-cased; whether Shiki has a grammar for it is known once Shiki loads.
 * Shiki itself loads with the first code block rather than with the app.
 */
export function languageOf(name: string | undefined): BundledLanguage | undefined {
	return (name?.toLowerCase() || undefined) as BundledLanguage | undefined;
}

// One highlighter for the app, with grammars and themes loaded as code blocks ask for them.
let shiki: Promise<typeof import("shiki")> | undefined;
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
	shiki ??= import("shiki");
	creating ??= shiki.then((module) =>
		module.createHighlighter({ themes: [], langs: [] }).then((created) => (highlighter = created)),
	);
	const task = shiki
		.then(async (module) => {
			// A language Shiki has no grammar for stays plain text.
			if (kind === "lang" && !(name in module.bundledLanguages || name in module.bundledLanguagesAlias)) return;
			const ready = await creating;
			await (kind === "lang"
				? ready?.loadLanguage(name as BundledLanguage)
				: ready?.loadTheme(name as BundledTheme));
			notify();
		})
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

/** The `span.line` elements of Shiki's `pre > code`. */
function linesOf(root: Root): Line[] {
	const pre = root.children[0];
	const code = pre?.type === "element" ? pre.children[0] : undefined;
	return code?.type === "element" ? code.children.filter((node) => node.type === "element") : [];
}

// Finished code, highlighted once: lists remount their rows on scroll and thread switches remount them all.
const CACHE_SIZE = 500;
const cache = new Map<string, Line[]>();

function highlight(highlighter: Highlighter, code: string, lang: BundledLanguage, theme: BundledTheme) {
	const key = `${theme}|${lang}|${code}`;
	const hit = cache.get(key);
	if (hit !== undefined) {
		cache.delete(key);
		cache.set(key, hit);
		return hit;
	}
	const lines = linesOf(highlighter.codeToHast(code, { lang, theme }));
	cache.set(key, lines);
	if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
	return lines;
}

/**
 * A block's highlighter for code that grows by appending: completed lines keep their nodes, and
 * only new lines and the open last line are tokenized, resuming from the grammar state where the
 * completed lines end. Shiki tokenizes line by line carrying that state, so the lines match a full
 * highlight of the code. It starts over when the language or theme changes or the code is rewritten.
 */
function incremental() {
	let key = "";
	let done = "";
	let lines: Line[] = [];
	let options: CodeToHastOptions<BundledLanguage, BundledTheme> | undefined;
	return (highlighter: Highlighter, code: string, lang: BundledLanguage, theme: BundledTheme) => {
		if (options === undefined || key !== `${theme}|${lang}` || !code.startsWith(done)) {
			key = `${theme}|${lang}`;
			done = "";
			lines = [];
			options = { lang, theme };
		}
		const end = code.lastIndexOf("\n") + 1;
		if (end > done.length) {
			const root = highlighter.codeToHast(code.slice(done.length, end - 1), options);
			const grammarState = highlighter.getLastGrammarState(root);
			lines = [...lines, ...linesOf(root)];
			if (grammarState !== undefined) options = { lang, theme, grammarState };
			done = code.slice(0, end);
		}
		return [...lines, ...linesOf(highlighter.codeToHast(code.slice(end), options))];
	};
}

/**
 * `code` highlighted for the palette, as Shiki's line elements, or undefined until its grammar and
 * theme have loaded (the caller shows the plain text meanwhile). Synchronous once loaded, so a
 * streaming block re-highlights in the same render as its text changes, with nothing to flash.
 * Finished code is `cached`; code still streaming grows incrementally instead, as caching would
 * only fill the cache with its prefixes.
 */
export function useHighlight(
	code: string,
	lang: BundledLanguage | undefined,
	theme: ThemeId,
	cached: boolean,
): readonly Line[] | undefined {
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	const [grow] = useState(incremental);
	useEffect(() => {
		listeners.add(rerender);
		return () => {
			listeners.delete(rerender);
		};
	}, []);
	const shikiTheme = SHIKI_THEMES[theme];
	if (lang === undefined || !ready(lang, shikiTheme) || highlighter === undefined) return undefined;
	// A CR may be half of a CRLF Shiki would split on.
	if (cached || code.includes("\r")) {
		return cached
			? highlight(highlighter, code, lang, shikiTheme)
			: linesOf(highlighter.codeToHast(code, { lang, theme: shikiTheme }));
	}
	return grow(highlighter, code, lang, shikiTheme);
}

const runtime = { Fragment, jsx, jsxs };

/** A completed line keeps its node while the code grows, so it renders once. */
const CodeLine = memo(function CodeLine({ line }: { readonly line: Line }) {
	return toJsxRuntime(line, runtime);
});

/** The highlighted lines alone, in Shiki's `code` shape: its `pre` (and background) is left out. */
export const HighlightedCode = memo(function HighlightedCode({ lines }: { readonly lines: readonly Line[] }) {
	return (
		<code>
			{lines.map((line, index) => (
				<Fragment key={index}>
					{index > 0 && "\n"}
					<CodeLine line={line} />
				</Fragment>
			))}
		</code>
	);
});
