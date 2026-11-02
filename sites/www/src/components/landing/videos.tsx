import { Play } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Arrows, Progress, railClass, slideClass, useRail } from "./rail";

export type Video = { id: string; title: string; channel: string };

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
	const { rail, thumb, index, goTo } = useRail(videos.length);
	const [playing, setPlaying] = useState<string | null>(null);

	// Leaving a slide silences it, however you left.
	useEffect(() => {
		setPlaying((current) => (current === videos[index]?.id ? current : null));
	}, [index, videos]);

	// A lone video has nowhere to go, so it gets no controls.
	const several = videos.length > 1;
	const arrows = <Arrows noun="video" onStep={(step) => goTo(index + step)} />;

	return (
		<>
			<div className="mx-auto flex max-w-6xl items-end justify-between gap-6 px-4 sm:px-6">
				<div>
					<h2 className="text-2xl font-semibold tracking-tight text-text sm:text-[1.75rem]">{title}</h2>
					<p className="mt-2 max-w-xl text-[15px] leading-relaxed text-text-secondary text-pretty">{children}</p>
				</div>
				{several && <div className="hidden sm:block">{arrows}</div>}
			</div>

			<div ref={rail} aria-roledescription="carousel" aria-label={title} className={`${railClass} mt-6 lg:mt-10`}>
				{videos.map((video, i) => {
					const label = `${video.title} by ${video.channel}`;
					return (
						<div
							key={video.id}
							data-slide={i}
							aria-roledescription="slide"
							aria-label={`${i + 1} of ${videos.length}: ${video.title}`}
							className={slideClass(i === index)}
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
					<Progress thumb={thumb} />
					<div className="mt-6 sm:hidden">{arrows}</div>
				</div>
			)}
		</>
	);
}
