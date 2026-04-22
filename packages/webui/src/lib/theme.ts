import type { DesktopTheme } from "@codeworksh/bridge";

type ThemeSnapshot = {
	theme: DesktopTheme;
	systemDark: boolean;
};

const LIGHT_BACKGROUND = "#ffffff";
const DARK_BACKGROUND = "#161616";
const STORAGE_KEY = "codework:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const THEME_COLOR_META_SELECTOR = 'meta[name="theme-color"]:not([media])';

let lastSnapshot: ThemeSnapshot | null = null;
let lastDesktopTheme: DesktopTheme | null = null;
let initialized = false;

function hasThemeStorage(): boolean {
	return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function getSystemDark(): boolean {
	return typeof window !== "undefined" && window.matchMedia(MEDIA_QUERY).matches;
}

function getStoredTheme(): DesktopTheme {
	if (!hasThemeStorage()) {
		return "system";
	}

	const rawTheme = window.localStorage.getItem(STORAGE_KEY);
	if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") {
		return rawTheme;
	}

	return "system";
}

function getSnapshot(): ThemeSnapshot {
	const theme = getStoredTheme();
	const systemDark = theme === "system" ? getSystemDark() : false;

	if (lastSnapshot && lastSnapshot.theme === theme && lastSnapshot.systemDark === systemDark) {
		return lastSnapshot;
	}

	lastSnapshot = { theme, systemDark };
	return lastSnapshot;
}

function getResolvedTheme(theme: DesktopTheme): "light" | "dark" {
	return theme === "system" ? (getSystemDark() ? "dark" : "light") : theme;
}

function getThemeColor(theme: DesktopTheme): string {
	return getResolvedTheme(theme) === "dark" ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}

function syncDesktopTheme(theme: DesktopTheme): void {
	const bridge = window.desktopBridge;
	if (!bridge || lastDesktopTheme === theme) {
		return;
	}

	lastDesktopTheme = theme;
	void bridge.setTheme(theme).catch(() => {
		if (lastDesktopTheme === theme) {
			lastDesktopTheme = null;
		}
	});
}

export function applyTheme(theme = getStoredTheme(), suppressTransitions = false): void {
	if (typeof document === "undefined" || typeof window === "undefined") {
		return;
	}

	if (suppressTransitions) {
		document.documentElement.classList.add("no-transitions");
	}

	const resolvedTheme = getResolvedTheme(theme);
	const backgroundColor = getThemeColor(theme);

	document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
	document.documentElement.style.colorScheme = resolvedTheme;
	document.documentElement.style.backgroundColor = backgroundColor;
	document.body.style.backgroundColor = backgroundColor;
	document.querySelector<HTMLMetaElement>(THEME_COLOR_META_SELECTOR)?.setAttribute("content", backgroundColor);
	syncDesktopTheme(theme);

	if (suppressTransitions) {
		// eslint-disable-next-line no-unused-expressions
		document.documentElement.offsetHeight;
		requestAnimationFrame(() => {
			document.documentElement.classList.remove("no-transitions");
		});
	}
}

export function initializeThemeSync(): void {
	if (initialized || typeof window === "undefined") {
		return;
	}

	initialized = true;
	applyTheme();

	const mediaQuery = window.matchMedia(MEDIA_QUERY);
	mediaQuery.addEventListener("change", () => {
		const snapshot = getSnapshot();
		if (snapshot.theme === "system") {
			applyTheme("system", true);
		}
	});

	window.addEventListener("storage", (event) => {
		if (event.key !== STORAGE_KEY) {
			return;
		}

		applyTheme(getStoredTheme(), true);
	});
}
