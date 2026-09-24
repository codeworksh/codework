import { useEffect, useRef, useState } from "react";
import shader from "./scene.wgsl?raw";
import { DEFAULT_THEME, THEME_EVENT, THEMES, readTheme } from "./theme";

const IMAGE = "/images/workspace.webp";
const SIZE = [1322, 920] as const;
/** Where the window cat looks when there is no pointer: straight out of the picture. */
const LOOK_AT_VIEWER: [number, number] = [188, 700];

type Rgb = [number, number, number];
const SHADES = ["shade0", "shade1", "shade2", "shade3", "shade4", "shade5"] as const;
const GLOWS = ["glow0", "glow1", "glow2"] as const;
type Ramp = Record<(typeof SHADES)[number] | (typeof GLOWS)[number], Rgb> & { strength: number; daylight: number };

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
	a[0] + (b[0] - a[0]) * t,
	a[1] + (b[1] - a[1]) * t,
	a[2] + (b[2] - a[2]) * t,
];
const BLACK: Rgb = [0, 0, 0];

/** Any CSS colour as 0..1 RGB, resolved by painting it on a 1px canvas. */
function rgbOf(color: string, probe: CanvasRenderingContext2D): Rgb {
	probe.clearRect(0, 0, 1, 1);
	probe.fillStyle = color;
	probe.fillRect(0, 0, 1, 1);
	const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
	return [r / 255, g / 255, b / 255];
}

/**
 * The active theme as the ramp scene.wgsl remaps the illustration onto. Dark themes keep the night
 * and use their own grounds and inks; light themes relight the room as day (see `day` in the
 * shader), running from their text colour to their page colour. CodeWork is the palette the art
 * was drawn in, so it shows as painted.
 */
function rampOf(probe: CanvasRenderingContext2D): Ramp {
	const style = getComputedStyle(document.documentElement);
	const token = (name: string) => rgbOf(style.getPropertyValue(`--t-${name}`).trim(), probe);
	const id = readTheme();
	const light = THEMES.find((t) => t.id === id)?.light === true;
	const [bg, text, brand] = [token("bg"), token("text"), token("brand")];
	const shades: Rgb[] = light
		? [mix(text, BLACK, 0.6), mix(text, BLACK, 0.4), mix(text, BLACK, 0.15), text, mix(text, bg, 0.5), bg]
		: [token("field-bg"), bg, token("surface-2"), token("border-strong"), token("text-muted"), text];
	const glows: Rgb[] = light
		? [mix(brand, BLACK, 0.3), brand, mix(brand, bg, 0.55)]
		: [token("field-mid"), token("field-lit"), token("field-crest")];
	return {
		...(Object.fromEntries(SHADES.map((name, i) => [name, shades[i]!])) as Record<(typeof SHADES)[number], Rgb>),
		...(Object.fromEntries(GLOWS.map((name, i) => [name, glows[i]!])) as Record<(typeof GLOWS)[number], Rgb>),
		strength: id === DEFAULT_THEME ? 0 : light ? 0.85 : 0.9,
		// Light themes see the room by day.
		daylight: light ? 1 : 0,
	};
}

/** Frames a theme change takes to fade into the scene; at 15% a frame, 30 frames close all but 1%. */
const FADE_FRAMES = 30;

/** Eases one ramp toward another, so a theme change fades into the scene rather than cutting. */
function approach(from: Ramp, to: Ramp, t: number): Ramp {
	const next = {
		...from,
		strength: from.strength + (to.strength - from.strength) * t,
		daylight: from.daylight + (to.daylight - from.daylight) * t,
	};
	for (const name of [...SHADES, ...GLOWS]) next[name] = mix(from[name], to[name], t);
	return next;
}

/** The ramp as the palette uniform wants it: each colour a vec4f. */
const uniformOf = (ramp: Ramp) => ({
	...Object.fromEntries([...SHADES, ...GLOWS].map((name) => [name, [...ramp[name], 1]])),
	strength: ramp.strength,
	daylight: ramp.daylight,
});

/**
 * The workspace illustration, animated by a WebGPU shader (scene.wgsl). The still image is the
 * fallback: it shows until the first frame is drawn, and stays for browsers without WebGPU and for
 * visitors who prefer reduced motion.
 */
export function Scene() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [live, setLive] = useState(false);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !("gpu" in navigator) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

		let cancelled = false;
		let teardown = () => {};

		const start = async () => {
			const { clock, effect, frameLoop, init, sampler, surface, texture } = await import("vgpu");
			const gpu = await init();
			if (cancelled) return gpu.dispose();

			const bitmap = await createImageBitmap(await (await fetch(IMAGE)).blob());
			const image = texture(gpu, {
				kind: "2d",
				size: SIZE,
				format: "rgba8unorm",
				usage: ["texture_binding", "copy_dst", "render_attachment"],
			});
			gpu.gpu.queue.copyExternalImageToTexture({ source: bitmap }, { texture: image.gpu }, SIZE);
			bitmap.close();

			const target = surface(gpu, canvas, { dpr: [1, 2] });
			const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
			if (!probe) return gpu.dispose();
			let wanted = rampOf(probe);
			let shown = wanted;
			const scene = effect(gpu, shader, {
				set: {
					params: { time: 0, pointer: LOOK_AT_VIEWER },
					palette: uniformOf(shown),
					scene: image,
					samp: sampler(gpu, { minFilter: "linear", magFilter: "linear" }),
				},
			});
			// Compile up front, against the surface's format (a surface only exists inside a frame): a shader
			// error rejects here, once, and leaves the still image in place.
			await scene.compile({ colors: [target.format] });
			if (cancelled) return gpu.dispose();
			const time = clock(gpu);

			// The pointer in image pixels, anywhere on the page, so the cat watches you scroll and point.
			let pointer = LOOK_AT_VIEWER;
			const onPointer = (event: PointerEvent) => {
				const box = canvas.getBoundingClientRect();
				pointer = [
					((event.clientX - box.left) / box.width) * SIZE[0],
					((event.clientY - box.top) / box.height) * SIZE[1],
				];
			};
			window.addEventListener("pointermove", onPointer, { passive: true });

			// A new theme fades in over FADE_FRAMES frames, then lands exactly on its ramp.
			let fading = 0;
			const onTheme = () => {
				wanted = rampOf(probe);
				fading = FADE_FRAMES;
			};
			window.addEventListener(THEME_EVENT, onTheme);

			// Ambient animation: 30fps is plenty, and nothing runs while the scene is off screen.
			let loop: { stop(): void } | null = null;
			const visibility = new IntersectionObserver(([entry]) => {
				if (entry?.isIntersecting && !loop) {
					loop = frameLoop(
						gpu,
						(frame) => {
							scene.set({ params: { time: time.time, pointer } });
							if (fading > 0) {
								fading--;
								shown = fading === 0 ? wanted : approach(shown, wanted, 0.15);
								scene.set({ palette: uniformOf(shown) });
							}
							frame.pass(target, scene);
							setLive(true);
						},
						{ fps: 30 },
					);
				} else if (!entry?.isIntersecting && loop) {
					loop.stop();
					loop = null;
				}
			});
			visibility.observe(canvas);

			teardown = () => {
				visibility.disconnect();
				window.removeEventListener("pointermove", onPointer);
				window.removeEventListener(THEME_EVENT, onTheme);
				loop?.stop();
				gpu.dispose();
			};
			if (cancelled) teardown();
		};

		start().catch((error: unknown) => console.warn("scene: showing the still image", error));
		return () => {
			cancelled = true;
			teardown();
		};
	}, []);

	return (
		<div className="relative aspect-1322/920 w-full overflow-hidden bg-field">
			<img
				src={IMAGE}
				alt=""
				width={SIZE[0]}
				height={SIZE[1]}
				loading="lazy"
				className="absolute inset-0 size-full"
			/>
			<canvas
				ref={canvasRef}
				aria-hidden="true"
				className={`absolute inset-0 size-full transition-opacity duration-500 ${live ? "opacity-100" : "opacity-0"}`}
			/>
		</div>
	);
}
