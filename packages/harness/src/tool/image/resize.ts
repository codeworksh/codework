import { Effect, Schema } from "effect";
import { Worker } from "node:worker_threads";
import { decode, load } from "./photon.ts";

export interface ResizeOptions {
	readonly maxWidth: number;
	readonly maxHeight: number;
	/** Most bytes of base64 payload. */
	readonly maxBytes: number;
	readonly jpegQuality: number;
}

export interface Resized {
	/** base64 */
	readonly data: string;
	readonly mimeType: string;
	readonly originalWidth: number;
	readonly originalHeight: number;
	readonly width: number;
	readonly height: number;
	readonly wasResized: boolean;
}

// 4.5MB of base64 leaves headroom below Anthropic's 5MB image limit.
export const defaults: ResizeOptions = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: 4.5 * 1024 * 1024,
	jpegQuality: 80,
};

/** Tags worker replies: Node posts its own messages on the worker channel too (e.g. under `--watch`). */
export const REPLY = "codework:photon-image-resize";

export type Reply = { type: typeof REPLY; result: Resized | null } | { type: typeof REPLY; error: string };

const base64 = (bytes: Uint8Array) => {
	const data = Buffer.from(bytes).toString("base64");
	return { data, size: data.length };
};

/**
 * Fit an image within the dimensions and encoded size, in this thread. `null`
 * when Photon is unavailable or nothing fits. Fits by: scaling to the max
 * dimensions, keeping the smaller of PNG and JPEG, lowering JPEG quality, then
 * shrinking by a quarter at a time down to 1x1.
 */
export const resizeInProcess = (
	input: Uint8Array,
	mimeType: string,
	options: ResizeOptions = defaults,
): Effect.Effect<Resized | null> =>
	Effect.map(load, (photon) => {
		if (photon === undefined) return null;
		let image: ReturnType<typeof decode> | undefined;
		try {
			image = decode(photon, input);
			const originalWidth = image.get_width();
			const originalHeight = image.get_height();
			const inputSize = Math.ceil(input.byteLength / 3) * 4;
			if (originalWidth <= options.maxWidth && originalHeight <= options.maxHeight && inputSize < options.maxBytes) {
				return {
					data: Buffer.from(input).toString("base64"),
					mimeType,
					originalWidth,
					originalHeight,
					width: originalWidth,
					height: originalHeight,
					wasResized: false,
				};
			}

			// A side never scales below one pixel, or a thin image would vanish.
			let width = originalWidth;
			let height = originalHeight;
			if (width > options.maxWidth) {
				height = Math.max(1, Math.round((height * options.maxWidth) / width));
				width = options.maxWidth;
			}
			if (height > options.maxHeight) {
				width = Math.max(1, Math.round((width * options.maxHeight) / height));
				height = options.maxHeight;
			}

			const qualities = [...new Set([options.jpegQuality, 85, 70, 55, 40])];
			while (true) {
				const resized = photon.resize(image, width, height, photon.SamplingFilter.Lanczos3);
				try {
					const candidates = [
						{ ...base64(resized.get_bytes()), mimeType: "image/png" },
						...qualities.map((quality) => ({
							...base64(resized.get_bytes_jpeg(quality)),
							mimeType: "image/jpeg",
						})),
					];
					const fit = candidates.find((candidate) => candidate.size < options.maxBytes);
					if (fit !== undefined) {
						return {
							data: fit.data,
							mimeType: fit.mimeType,
							originalWidth,
							originalHeight,
							width,
							height,
							wasResized: true,
						};
					}
				} finally {
					resized.free();
				}
				const nextWidth = Math.max(1, Math.floor(width * 0.75));
				const nextHeight = Math.max(1, Math.floor(height * 0.75));
				if (nextWidth === width && nextHeight === height) return null;
				width = nextWidth;
				height = nextHeight;
			}
		} catch {
			return null;
		} finally {
			image?.free();
		}
	});

// From source the worker sits beside this module; packed, this module lands in a
// chunk at the package's output root while the worker keeps its own entry path.
const workerUrl = (): URL =>
	import.meta.url.endsWith(".ts")
		? new URL("./worker.ts", import.meta.url)
		: new URL("./tool/image/worker.mjs", import.meta.url);

/** The worker could not resize; the caller falls back to this thread. */
class WorkerError extends Schema.TaggedError<WorkerError>()("ImageResizeWorkerError", { message: Schema.String }) {}

const inWorker = (input: Uint8Array, mimeType: string, options: ResizeOptions) =>
	Effect.callback<Resized | null, WorkerError>((resume) => {
		let worker: Worker;
		try {
			worker = new Worker(workerUrl());
		} catch (cause) {
			// e.g. a Node permission model without worker access: resize in this thread instead.
			resume(Effect.fail(new WorkerError({ message: String(cause) })));
			return;
		}
		const done = (effect: Effect.Effect<Resized | null, WorkerError>) => {
			resume(effect);
			void worker.terminate().catch(() => undefined);
		};
		worker.on("message", (message: unknown) => {
			const reply = message as Partial<Reply> | null;
			if (reply?.type !== REPLY) return;
			done(
				"error" in reply
					? Effect.fail(new WorkerError({ message: reply.error }))
					: Effect.succeed((reply as { result: Resized | null }).result),
			);
		});
		worker.once("error", (error: Error) => done(Effect.fail(new WorkerError({ message: error.message }))));
		worker.once("exit", (code) =>
			done(Effect.fail(new WorkerError({ message: `Image resize worker exited with code ${code}` }))),
		);
		// Transferring detaches the buffer, so hand over a copy and leave the caller's bytes intact.
		const bytes = new Uint8Array(input);
		worker.postMessage({ input: bytes, mimeType, options }, [bytes.buffer]);
		return Effect.promise(() => worker.terminate());
	});

/**
 * {@link resizeInProcess} on a worker thread, so decoding and encoding a large
 * image never blocks the harness's event loop. Falls back to this thread when a
 * worker cannot start, so a read still works.
 */
export const resize = (input: Uint8Array, mimeType: string, options: ResizeOptions = defaults) =>
	inWorker(input, mimeType, options).pipe(Effect.catch(() => resizeInProcess(input, mimeType, options)));

/** Tells the model how to map coordinates on a resized image back to the original. */
export const dimensionNote = (result: Resized): string | undefined => {
	if (!result.wasResized) return undefined;
	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
};
