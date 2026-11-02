import { Arrows, Progress, railClass, slideClass, useRail } from "./rail";

export type Screen = { title: string; body: string; src: string; alt: string };

/** A full-bleed rail of app screenshots; the title and line above follow the screenshot in view. */
export function Screens({ label, screens }: { label: string; screens: readonly Screen[] }) {
	const { rail, thumb, index, goTo } = useRail(screens.length);
	const arrows = <Arrows noun="screenshot" onStep={(step) => goTo(index + step)} />;

	return (
		<>
			<div className="mx-auto flex max-w-6xl items-end justify-between gap-6 px-4 sm:px-6">
				{/* Every caption shares one cell, so the header keeps the tallest one's height as they swap. */}
				<div aria-live="polite" className="grid max-w-xl">
					{screens.map((screen, i) => (
						<div
							key={screen.src}
							aria-hidden={i !== index}
							className={`[grid-area:1/1] transition-opacity duration-200 ease-out motion-reduce:transition-none ${i === index ? "opacity-100" : "opacity-0"}`}
						>
							<h2 className="text-2xl font-semibold tracking-tight text-text text-balance sm:text-[1.75rem]">
								{screen.title}
							</h2>
							<p className="mt-2 text-[15px] leading-relaxed text-text-secondary text-pretty">{screen.body}</p>
						</div>
					))}
				</div>
				<div className="hidden sm:block">{arrows}</div>
			</div>

			<div ref={rail} aria-roledescription="carousel" aria-label={label} className={`${railClass} mt-6 lg:mt-10`}>
				{screens.map((screen, i) => (
					<div
						key={screen.src}
						aria-roledescription="slide"
						aria-label={`${i + 1} of ${screens.length}: ${screen.title}`}
						className={slideClass(i === index)}
					>
						<img
							src={screen.src}
							alt={screen.alt}
							width={1440}
							height={900}
							loading={i === 0 ? "eager" : "lazy"}
							decoding="async"
							draggable={false}
							className="block h-auto w-full rounded-lg shadow-[0_24px_60px_-24px_rgb(0_0_0/0.6)] outline-1 -outline-offset-1 outline-white/10"
						/>
					</div>
				))}
			</div>

			<div className="mx-auto max-w-6xl px-4 sm:px-6">
				<Progress thumb={thumb} />
				<div className="mt-6 sm:hidden">{arrows}</div>
			</div>
		</>
	);
}
