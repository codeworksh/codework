import { Atom } from "effect/reactivity";

/**
 * Colour themes: the codework.sh palettes in themes.css, keyed by id. The choice is saved per
 * device; index.html applies it before first paint under the same storage key.
 */
export const THEMES = [
	{ id: "catppuccin", name: "Catppuccin" },
	{ id: "catppuccin-latte", name: "Catppuccin Latte" },
	{ id: "ethereal", name: "Ethereal" },
	{ id: "everforest", name: "Everforest" },
	{ id: "flexoki-light", name: "Flexoki Light" },
	{ id: "gruvbox", name: "Gruvbox" },
	{ id: "hackerman", name: "Hackerman" },
	{ id: "kanagawa", name: "Kanagawa" },
	{ id: "last-horizon", name: "Last Horizon" },
	{ id: "lumon", name: "Lumon" },
	{ id: "lupine", name: "Lupine" },
	{ id: "matte-black", name: "Matte Black" },
	{ id: "miasma", name: "Miasma" },
	{ id: "nord", name: "Nord" },
	{ id: "osaka-jade", name: "Osaka Jade" },
	{ id: "retro-82", name: "Retro 82" },
	{ id: "ristretto", name: "Ristretto" },
	{ id: "rose-pine", name: "Rosé Pine" },
	{ id: "solitude", name: "Solitude" },
	{ id: "tokyo-night", name: "Tokyo Night" },
	{ id: "vantablack", name: "Vantablack" },
	{ id: "white", name: "White" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const DEFAULT_THEME: ThemeId = "tokyo-night";
const STORAGE_KEY = "codework-theme";

export const isTheme = (id: string): id is ThemeId => THEMES.some((theme) => theme.id === id);

/** The saved theme, or the default when nothing valid is saved. */
function savedTheme(): ThemeId {
	try {
		const id = localStorage.getItem(STORAGE_KEY);
		if (id !== null && isTheme(id)) return id;
	} catch {
		// Storage can be unavailable; the default applies.
	}
	return DEFAULT_THEME;
}

/** Shows a theme without saving it, e.g. while browsing the list. */
export function previewTheme(id: ThemeId) {
	const root = document.documentElement;
	if (root.dataset.theme === id) return;
	// A swap must not tween: each element's colours would animate on their own.
	root.classList.add("no-transitions");
	root.dataset.theme = id;
	requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("no-transitions")));
}

/** The saved theme; setting it applies and saves it, so the palette and settings stay in step. */
export const themeAtom = Atom.writable<ThemeId, ThemeId>(savedTheme, (ctx, id) => {
	previewTheme(id);
	try {
		localStorage.setItem(STORAGE_KEY, id);
	} catch {
		// The theme still applies for this run.
	}
	ctx.setSelf(id);
}).pipe(Atom.keepAlive);
