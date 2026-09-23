import { Palette } from "lucide-react";
import { useEffect, useState } from "react";
import { GITHUB_URL, nav } from "./content";
import { GithubIcon } from "./github";
import { Pixels } from "./pixels";
import { OPEN_PICKER_EVENT } from "./theme";
import { MARK } from "./wordmark";

/** Sits transparent over the hero, and picks up a ground once the hero has scrolled under it. */
export function Header() {
	const [overHero, setOverHero] = useState(true);

	useEffect(() => {
		const hero = document.querySelector("[data-hero]");
		if (!hero) return setOverHero(false);
		const bar = document.querySelector("header")?.getBoundingClientRect().height ?? 56;
		const observer = new IntersectionObserver(([entry]) => setOverHero(entry?.isIntersecting ?? false), {
			rootMargin: `-${bar}px 0px 0px 0px`,
		});
		observer.observe(hero);
		return () => observer.disconnect();
	}, []);

	return (
		<header
			className={`sticky top-0 z-50 h-(--nav-h) transition-colors duration-200 ${
				overHero ? "bg-transparent" : "border-b border-border-subtle bg-bg/90 backdrop-blur"
			}`}
		>
			<div className="mx-auto flex h-full max-w-6xl items-center gap-3 px-4 sm:px-6">
				<a
					href="/"
					aria-label="CodeWork home"
					className="text-brand transition-colors hover:text-(--t-field-hover)"
				>
					<Pixels glyph={MARK} className="size-[22px]" />
				</a>
				<nav className="hidden items-center sm:flex">
					{nav.map((link) => (
						<a
							key={link.label}
							href={link.href}
							className="px-3 py-1.5 text-sm text-text-secondary transition-colors hover:text-text"
						>
							{link.label}
						</a>
					))}
				</nav>
				<div className="ml-auto flex items-center gap-2.5">
					<button
						type="button"
						aria-label="Change the theme"
						title="Change the theme (T)"
						onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PICKER_EVENT))}
						className="flex h-8 items-center gap-1.5 px-1.5 text-text-secondary transition-colors hover:text-text"
					>
						<Palette className="size-5" />
						<kbd
							aria-hidden="true"
							className="hidden border border-border-strong px-1 text-[11px] leading-4 sm:block"
						>
							T
						</kbd>
					</button>
					<a
						href={GITHUB_URL}
						aria-label="GitHub"
						className="flex size-8 items-center justify-center text-text-secondary transition-colors hover:text-text"
					>
						<GithubIcon className="size-5" />
					</a>
					<a
						href="/docs/"
						className="inline-flex h-8 items-center border border-transparent bg-brand px-3 text-sm font-medium text-brand-ink transition-colors hover:bg-[color-mix(in_oklch,var(--color-brand),white_14%)]"
					>
						Get started
					</a>
				</div>
			</div>
		</header>
	);
}
