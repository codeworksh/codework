import { Atom } from "effect/reactivity";

/** Light and dark themes, saved per device and applied before first paint by index.html. */
export const THEMES = [
	{ id: "light", name: "Light" },
	{ id: "dark", name: "Dark" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const DEFAULT_THEME: ThemeId = "dark";
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
