import { ArrowRight, BookOpen } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { hero } from "./content";
import { Field } from "./field";
import { GithubIcon } from "./github";
import { Pixels } from "./pixels";
import { WORDMARK } from "./wordmark";

const button =
	"inline-flex h-10 items-center justify-center gap-2 border pr-4 pl-3 text-[15px] font-medium whitespace-nowrap transition-[background-color,transform] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:scale-[0.96] [&_svg]:size-5";

export function Hero() {
	// The SVG word is there before any script runs; it steps aside once the canvas paints the same cells.
	const [painted, setPainted] = useState(false);

	return (
		<section
			id="home"
			data-hero
			className="pixel-container relative -mt-(--nav-h) flex min-h-svh flex-col overflow-hidden border-b border-border-subtle bg-field pt-(--nav-h) select-none"
		>
			<div aria-hidden="true" className="pointer-events-none absolute inset-0">
				<Field onPainted={() => setPainted(true)} />
			</div>

			<div className="pointer-events-none relative flex flex-1 flex-col items-center px-6">
				<div className="flex-1" />
				<div
					data-hero-quiet
					className="pointer-events-auto mb-12 flex w-full justify-center lg:mb-[calc(var(--pxc)*5)]"
				>
					<a
						href={hero.callout.href}
						data-hero-stagger
						className="group inline-flex max-w-full items-center gap-2 border border-brand/40 bg-bg/60 px-3.5 py-1.5 text-left text-[13px] leading-snug text-brand transition-colors duration-150 ease-out hover:border-brand hover:bg-brand hover:text-bg"
					>
						<span className="min-w-0">{hero.callout.text}</span>
						<ArrowRight className="size-4 shrink-0 transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
					</a>
				</div>

				<div data-hero-wordmark className={`w-[88%] max-w-4xl ${painted ? "invisible" : ""}`}>
					<span className="sr-only">CodeWork</span>
					<Pixels glyph={WORDMARK} banded className="block h-auto w-full" />
				</div>

				<div
					data-hero-quiet
					className="pointer-events-auto mt-12 flex w-full max-w-2xl flex-col items-center text-center lg:mt-[calc(var(--pxc)*5)]"
				>
					<h1
						data-hero-stagger
						style={{ "--stagger": 0, fontFamily: "var(--font-mono)" } as CSSProperties}
						className="text-2xl font-medium tracking-tight text-text sm:text-3xl"
					>
						<span className="sr-only">CodeWork: </span>
						{hero.title}
					</h1>
					<p
						data-hero-stagger
						style={{ "--stagger": 1 } as CSSProperties}
						className="mt-4 text-[15px] leading-relaxed text-text-secondary"
					>
						{hero.lines.map((line) => (
							<span key={line} className="block text-balance">
								{line}
							</span>
						))}
					</p>
					<div
						data-hero-stagger
						style={{ "--stagger": 2 } as CSSProperties}
						className="mt-9 flex w-full max-w-xs flex-col items-stretch gap-3 sm:w-auto sm:max-w-none sm:flex-row lg:gap-[calc(var(--pxc)*2)]"
					>
						<a
							href={hero.primary.href}
							className={`${button} border-transparent bg-brand text-brand-ink hover:bg-[color-mix(in_oklch,var(--color-brand),white_14%)]`}
						>
							<BookOpen />
							{hero.primary.label}
						</a>
						<a
							href={hero.secondary.href}
							className={`${button} border-border-strong bg-surface text-text hover:bg-surface-2`}
						>
							<GithubIcon />
							{hero.secondary.label}
						</a>
					</div>
				</div>
				<div className="flex-1" />
			</div>
		</section>
	);
}
