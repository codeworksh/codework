import { ChevronLeft, ChevronRight, Play } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

export type Video = { id: string; title: string; channel: string };

const arrow =
	"flex size-9 items-center justify-center border border-border-strong bg-surface text-text transition-colors duration-150 ease-out hover:bg-surface-2";

/** A full-bleed rail of YouTube videos: thumbnails until played, so nothing loads from YouTube up front. */
export function Videos({
	title,
	videos,
	children,
}: {
	title: string;
	/** The line under the title. */
	children: ReactNode;
	videos: readonly Video[];
}) {
	const rail = useRef<HTMLDivElement>(null);
	const thumb = useRef<HTMLDivElement>(null);
	const [index, setIndex] = useState(0);
	const [playing, setPlaying] = useState<string | null>(null);

	useEffect(() => {
		const el = rail.current;
		if (!el) return;
		const sync = () => {
			// The current slide is the one nearest the centre; on wide screens a neighbour can be mostly in view too.
			const centre = el.scrollLeft + el.clientWidth / 2;
			const slides = [...el.children] as HTMLElement[];
			const distance = (s: HTMLElement) => Math.abs(s.offsetLeft + s.clientWidth / 2 - centre);
			setIndex(slides.reduce((best, s, i) => (distance(s) < distance(slides[best]!) ? i : best), 0));

			// The rail is full-bleed, so its own scrollbar would span the window; this one sits in the content column.
			const bar = thumb.current;
			if (!bar) return;
			const reach = el.scrollWidth - el.clientWidth;
			const ratio = Math.min(1, el.clientWidth / el.scrollWidth);
			const progress = reach > 0 ? el.scrollLeft / reach : 0;
			bar.style.width = `${ratio * 100}%`;
			bar.style.transform = `translateX(${(progress * (1 - ratio) * 100) / ratio}%)`;
		};
		const sizes = new ResizeObserver(sync);
		sizes.observe(el);
		el.addEventListener("scroll", sync, { passive: true });
		return () => {
			sizes.disconnect();
			el.removeEventListener("scroll", sync);
		};
	}, []);

	// Leaving a slide silences it, however you left.
	useEffect(() => {
		setPlaying((current) => (current === videos[index]?.id ? current : null));
	}, [index, videos]);

	const goTo = (i: number) => {
		const el = rail.current;
		const slide = el?.children[(i + videos.length) % videos.length] as HTMLElement | undefined;
		if (!el || !slide) return;
		el.scrollTo({ left: slide.offsetLeft - (el.clientWidth - slide.clientWidth) / 2 });
	};

	// A lone video has nowhere to go, so it gets no controls.
	const several = videos.length > 1;
	const arrows = (
		<div className="flex gap-2">
			<button type="button" aria-label="Previous video" className={arrow} onClick={() => goTo(index - 1)}>
				<ChevronLeft className="size-5" />
			</button>
			<button type="button" aria-label="Next video" className={arrow} onClick={() => goTo(index + 1)}>
				<ChevronRight className="size-5" />
			</button>
		</div>
	);

	return (
		<>
			<div className="mx-auto flex max-w-6xl items-end justify-between gap-6 px-4 sm:px-6">
				<div>
					<h2 className="text-2xl font-semibold tracking-tight text-text sm:text-[1.75rem]">{title}</h2>
					<p className="mt-2 max-w-xl text-[15px] leading-relaxed text-text-secondary text-pretty">{children}</p>
				</div>
				{several && <div className="hidden sm:block">{arrows}</div>}
			</div>

			<div
				ref={rail}
				aria-roledescription="carousel"
				aria-label={title}
				className="rail mt-6 flex snap-x snap-mandatory gap-4 overflow-x-auto motion-safe:scroll-smooth lg:mt-10"
			>
				{videos.map((video, i) => {
					const label = `${video.title} by ${video.channel}`;
					return (
						<div
							key={video.id}
							data-slide={i}
							aria-roledescription="slide"
							aria-label={`${i + 1} of ${videos.length}: ${video.title}`}
							className={`w-full shrink-0 snap-center transition-[opacity,filter] duration-300 ease-out ${i === index ? "" : "opacity-40 brightness-75"}`}
						>
							{playing === video.id ? (
								<iframe
									src={`https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1`}
									title={label}
									allow="autoplay; encrypted-media; picture-in-picture"
									allowFullScreen
									className="aspect-video w-full border border-border-subtle"
								/>
							) : (
								<button
									type="button"
									onClick={() => (i === index ? setPlaying(video.id) : goTo(i))}
									aria-label={`${i === index ? "Play" : "Show"}: ${label}`}
									className="group relative block w-full text-left"
								>
									<img
										src={`https://i.ytimg.com/vi/${video.id}/maxresdefault.jpg`}
										alt=""
										width={1280}
										height={720}
										loading="lazy"
										decoding="async"
										draggable={false}
										className="aspect-video w-full border border-border-subtle object-cover"
									/>
									{i === index && (
										<span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
											<span className="flex size-16 items-center justify-center bg-brand text-brand-ink shadow-lg transition-transform duration-150 ease-out group-hover:scale-105">
												<Play className="size-6 fill-current" />
											</span>
										</span>
									)}
									<span className="absolute inset-x-px bottom-px bg-linear-to-t from-black/70 to-transparent p-5 pt-12">
										<span className="block text-base font-medium text-white">{video.title}</span>
										<span className="mt-0.5 block font-mono text-[13px] text-white/70">{video.channel}</span>
									</span>
								</button>
							)}
						</div>
					);
				})}
			</div>

			{several && (
				<div className="mx-auto max-w-6xl px-4 sm:px-6">
					<div aria-hidden="true" className="mt-5 h-1.5 bg-border-subtle/50">
						<div ref={thumb} className="h-full bg-brand" />
					</div>
					<div className="mt-6 sm:hidden">{arrows}</div>
				</div>
			)}
		</>
	);
}
