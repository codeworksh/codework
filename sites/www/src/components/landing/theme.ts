/**
 * Site themes: the palette list, the head script that stamps the saved one before first paint,
 * and the switch the picker runs. Palettes live in styles/themes.css, keyed by id.
 */

export type Theme = { id: string; name: string; light?: true };

export const THEMES: Theme[] = [
	{ id: "codework", name: "CodeWork" },
	{ id: "catppuccin", name: "Catppuccin" },
	{ id: "catppuccin-latte", name: "Catppuccin Latte", light: true },
	{ id: "ethereal", name: "Ethereal" },
	{ id: "everforest", name: "Everforest" },
	{ id: "flexoki-light", name: "Flexoki Light", light: true },
	{ id: "gruvbox", name: "Gruvbox" },
	{ id: "hackerman", name: "Hackerman" },
	{ id: "kanagawa", name: "Kanagawa" },
	{ id: "last-horizon", name: "Last Horizon" },
	{ id: "lumon", name: "Lumon" },
	{ id: "lupine", name: "Lupine", light: true },
	{ id: "matte-black", name: "Matte Black" },
	{ id: "miasma", name: "Miasma" },
	{ id: "nord", name: "Nord" },
	{ id: "osaka-jade", name: "Osaka Jade" },
	{ id: "retro-82", name: "Retro 82" },
	{ id: "ristretto", name: "Ristretto" },
	{ id: "rose-pine", name: "Rosé Pine", light: true },
	{ id: "solitude", name: "Solitude" },
	{ id: "tokyo-night", name: "Tokyo Night" },
	{ id: "vantablack", name: "Vantablack" },
	{ id: "white", name: "White", light: true },
];

export const DEFAULT_THEME = "codework";
const THEME_KEY = "codework-theme";
/** Set once the visitor has opened the picker or dismissed the hint. */
export const HINT_KEY = "codework-theme-hint-seen";
/** Fired on window after a theme lands, so canvases can re-read their inks. */
export const THEME_EVENT = "codework-theme";
/** Ask the picker to open, from anywhere on the page. */
export const OPEN_PICKER_EVENT = "codework-open-picker";

/** Theme previews: Omarchy's screenshots for now, CodeWork's own illustration for the default. */
export const previewOf = (id: string) =>
	id === DEFAULT_THEME ? "/images/workspace.webp" : `https://omarchy.org/assets/images/theme-previews/${id}.webp`;

/** Inlined in <head> so the saved theme is on the page before it first paints. */
export const themeInitScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(${JSON.stringify(
	THEMES.map((t) => t.id),
)}.indexOf(t)>=0)document.documentElement.dataset.theme=t}catch(e){}})()`;

export function readTheme(): string {
	const current = document.documentElement.dataset.theme;
	return THEMES.some((t) => t.id === current) ? current! : DEFAULT_THEME;
}

function applyTheme(id: string) {
	const root = document.documentElement;
	root.classList.add("no-transitions");
	root.dataset.theme = id;
	try {
		localStorage.setItem(THEME_KEY, id);
	} catch {
		// Storage can be unavailable; the theme still applies for this visit.
	}
	window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: id }));
	requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("no-transitions")));
}

/**
 * Switches theme behind the split-wipe (styles/wipe.css). `frosted` blurs the old page's snapshot,
 * for a switch made from the picker, whose dimmer already blurs the page.
 */
export function switchTheme(id: string, after?: () => void, frosted = false) {
	const update = () => {
		applyTheme(id);
		after?.();
	};
	if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
		update();
		return;
	}
	const root = document.documentElement;
	if (frosted) root.classList.add("theme-wipe-frosted");
	const done = () => root.classList.remove("theme-wipe-frosted");
	document.startViewTransition(update).finished.then(done, done);
}
