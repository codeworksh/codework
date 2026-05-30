// Make the site name in the header clickable (linking to the documentation home)
(function () {
	const logo = document.querySelector("header.md-header a.md-logo");
	const href = logo && logo.getAttribute("href");
	if (!href) return;

	const siteName = document.querySelector(
		"header.md-header .md-header__title .md-header__topic:not([data-md-component]) > .md-ellipsis",
	);
	if (!siteName) return;

	if (siteName.closest("a")) return;

	const a = document.createElement("a");
	a.href = href;
	a.className = siteName.className;
	a.textContent = (siteName.textContent || "").trim();
	a.setAttribute("aria-label", "Home");

	siteName.replaceWith(a);
})();
