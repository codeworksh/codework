import { Effect } from "effect";
import { decode, load } from "./photon.ts";
import { dimensionNote, resize } from "./resize.ts";

export { detectOf, type ByteSource } from "./mime.ts";

/** What the model receives for an image file. */
export type Inline =
	| { readonly ok: true; readonly data: string; readonly mimeType: string; readonly hints: ReadonlyArray<string> }
	| { readonly ok: false; readonly message: string };

/** Formats every provider takes inline; anything else (BMP) is converted to PNG first. */
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const toPng = (bytes: Uint8Array) =>
	load.pipe(
		Effect.map((photon) => {
			if (photon === undefined) return undefined;
			try {
				const image = decode(photon, bytes);
				try {
					return new Uint8Array(image.get_bytes());
				} finally {
					image.free();
				}
			} catch {
				return undefined;
			}
		}),
	);

/**
 * Turn an image file into what a model takes inline: a supported format, within
 * the provider's dimension and size limits. A failure is a note for the model,
 * never an error — the read itself succeeded.
 */
export const inline = Effect.fn("Image.inline")(function* (bytes: Uint8Array, mimeType: string) {
	let source = { bytes, mimeType, convertedFrom: undefined as string | undefined };
	if (!INLINE.has(mimeType)) {
		const png = yield* toPng(bytes);
		if (png === undefined)
			return {
				ok: false,
				message: "[Image omitted: could not be converted to a supported inline image format.]",
			} satisfies Inline;
		source = { bytes: png, mimeType: "image/png", convertedFrom: mimeType };
	}

	const resized = yield* resize(source.bytes, source.mimeType);
	if (resized === null)
		return {
			ok: false,
			message: "[Image omitted: could not be resized below the inline image size limit.]",
		} satisfies Inline;

	const hints: Array<string> = [];
	if (source.convertedFrom !== undefined && source.convertedFrom !== resized.mimeType)
		hints.push(`[Image converted from ${source.convertedFrom} to ${resized.mimeType}.]`);
	const note = dimensionNote(resized);
	if (note !== undefined) hints.push(note);
	return { ok: true, data: resized.data, mimeType: resized.mimeType, hints } satisfies Inline;
});

export * as Image from "./index.ts";
