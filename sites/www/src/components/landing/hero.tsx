import { ArrowRight, BookOpen } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { hero } from "./content";
import { Field } from "./field";
import { GithubIcon } from "./github";
import { Install } from "./install";
import { Pixels } from "./pixels";
import { WORDMARK } from "./wordmark";

const linkIcons = [BookOpen, GithubIcon];

export function Hero(props: { callout?: { text: string; href: string } | undefined }) {
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
				{props.callout && (
					<div
						data-hero-quiet
						className="pointer-events-auto mb-12 flex w-full justify-center lg:mb-[calc(var(--pxc)*5)]"
					>
						<a
							href={props.callout.href}
							data-hero-stagger
							className="group inline-flex max-w-full items-center gap-2 border border-brand/40 bg-bg/60 px-3.5 py-1.5 text-left text-[13px] leading-snug text-brand transition-colors duration-150 ease-out hover:border-brand hover:bg-brand hover:text-bg"
						>
							<span className="min-w-0">{props.callout.text}</span>
							<ArrowRight className="size-4 shrink-0 transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
						</a>
					</div>
				)}

				<div data-hero-wordmark className={`w-[88%] max-w-4xl ${painted ? "invisible" : ""}`}>
					<span className="sr-only">CodeWork</span>
					<Pixels glyph={WORDMARK} depth className="block h-auto w-full text-brand" />
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
						className="mt-9 flex w-full flex-col items-center gap-4"
					>
						<Install />
						<div className="flex items-center gap-5 text-[13px] font-medium">
							{hero.links.map((link, i) => {
								const Icon = linkIcons[i]!;
								return (
									<a
										key={link.href}
										href={link.href}
										className="inline-flex items-center gap-1.5 text-text-secondary transition-colors duration-150 ease-out hover:text-brand [&_svg]:size-4"
									>
										<Icon />
										{link.label}
									</a>
								);
							})}
						</div>
					</div>
				</div>
				<div className="flex-1" />
			</div>
		</section>
	);
}
