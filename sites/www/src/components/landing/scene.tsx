import { useEffect, useRef, useState } from "react";
import shader from "./scene.wgsl?raw";

const IMAGE = "/images/workspace.webp";
const SIZE = [1322, 920] as const;
/** Where the window cat looks when there is no pointer: straight out of the picture. */
const LOOK_AT_VIEWER: [number, number] = [188, 700];

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
			const scene = effect(gpu, shader, {
				set: {
					params: { time: 0, pointer: LOOK_AT_VIEWER },
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

			// Ambient animation: 30fps is plenty, and nothing runs while the scene is off screen.
			let loop: { stop(): void } | null = null;
			const visibility = new IntersectionObserver(([entry]) => {
				if (entry?.isIntersecting && !loop) {
					loop = frameLoop(
						gpu,
						(frame) => {
							scene.set({ params: { time: time.time, pointer } });
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
		<div className="relative aspect-[1322/920] w-full overflow-hidden bg-field">
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
