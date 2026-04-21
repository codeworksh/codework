(() => {
	const LIGHT_BACKGROUND = "#ffffff";
	const DARK_BACKGROUND = "#161616";
	const THEME_STORAGE_KEY = "codework:theme";
	const themeColorMeta = document.querySelector('meta[name="theme-color"]');

	document.documentElement.dataset.bootShellStartedAt = String(performance.now());

	try {
		const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
		const theme =
			storedTheme === "light" || storedTheme === "dark" || storedTheme === "system" ? storedTheme : "system";
		const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
		const isDark = theme === "dark" || (theme === "system" && prefersDark);
		const chromeColor = isDark ? DARK_BACKGROUND : LIGHT_BACKGROUND;

		document.documentElement.classList.toggle("dark", isDark);
		document.documentElement.style.colorScheme = isDark ? "dark" : "light";
		document.documentElement.style.backgroundColor = chromeColor;
		themeColorMeta?.setAttribute("content", chromeColor);
	} catch {
		document.documentElement.classList.add("dark");
		document.documentElement.style.colorScheme = "dark";
		document.documentElement.style.backgroundColor = DARK_BACKGROUND;
		themeColorMeta?.setAttribute("content", DARK_BACKGROUND);
	}
})();
