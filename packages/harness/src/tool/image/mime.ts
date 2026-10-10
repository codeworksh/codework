import { Effect } from "effect";

/**
 * Image formats a model takes inline, told apart by their bytes, never by the
 * file name: a text file that starts with `GIF` is still text.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Bytes every check except the APNG chunk walk needs: BMP reads up to offset 29. */
const HEADER_BYTES = 32;
const BLOCK_BYTES = 64 * 1024;

/** Positional reads of a file of `size` bytes. */
export interface ByteSource<E> {
	readonly size: number;
	readonly read: (offset: number, length: number) => Effect.Effect<Uint8Array, E>;
}

/**
 * The image MIME type of a whole file, reading only its header and, for PNG, the
 * chunk headers up to the first `acTL` or `IDAT`. Animated PNGs are not images
 * here: a model would see only their first frame.
 */
export const detectOf = <E>(source: ByteSource<E>): Effect.Effect<string | undefined, E> =>
	Effect.gen(function* () {
		const header = yield* source.read(0, HEADER_BYTES);
		if (!startsWith(header, PNG_SIGNATURE)) return detect(header);
		return isPng(header) && !(yield* isAnimatedPngOf(source)) ? "image/png" : undefined;
	});

const isAnimatedPngOf = <E>(source: ByteSource<E>): Effect.Effect<boolean, E> =>
	Effect.gen(function* () {
		let block: Uint8Array = new Uint8Array(0);
		let blockStart = 0;
		let offset = PNG_SIGNATURE.length;
		while (offset + 8 <= source.size) {
			if (offset < blockStart || offset + 8 > blockStart + block.length) {
				blockStart = offset;
				block = yield* source.read(offset, BLOCK_BYTES);
			}
			const chunkHeader = block.subarray(offset - blockStart, offset - blockStart + 8);
			// A size the backend could not report ends the walk at the real end of the file.
			if (chunkHeader.length < 8) return false;
			if (startsWithAscii(chunkHeader, 4, "acTL")) return true;
			if (startsWithAscii(chunkHeader, 4, "IDAT")) return false;
			const nextOffset = offset + 8 + readUint32BE(chunkHeader, 0) + 4;
			if (nextOffset <= offset || nextOffset > source.size) return false;
			offset = nextOffset;
		}
		return false;
	});

/** The image MIME type of a header; a PNG still needs {@link isAnimatedPngOf}. */
const detect = (buffer: Uint8Array): string | undefined => {
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) return buffer[3] === 0xf7 ? undefined : "image/jpeg";
	if (startsWith(buffer, PNG_SIGNATURE)) return isPng(buffer) ? "image/png" : undefined;
	if (startsWithAscii(buffer, 0, "GIF87a") || startsWithAscii(buffer, 0, "GIF89a")) return "image/gif";
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) return "image/webp";
	if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) return "image/bmp";
	return undefined;
};

const isPng = (buffer: Uint8Array): boolean =>
	buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR");

const isBmp = (buffer: Uint8Array): boolean => {
	if (buffer.length < 26) return false;
	const declaredFileSize = readUint32LE(buffer, 2);
	const pixelDataOffset = readUint32LE(buffer, 10);
	const dibHeaderSize = readUint32LE(buffer, 14);
	if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
	if (pixelDataOffset < 14 + dibHeaderSize) return false;
	if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;

	let colorPlanes: number;
	let bitsPerPixel: number;
	if (dibHeaderSize === 12) {
		colorPlanes = readUint16LE(buffer, 22);
		bitsPerPixel = readUint16LE(buffer, 24);
	} else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
		if (buffer.length < 30) return false;
		colorPlanes = readUint16LE(buffer, 26);
		bitsPerPixel = readUint16LE(buffer, 28);
	} else {
		return false;
	}
	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
};

const readUint16LE = (buffer: Uint8Array, offset: number): number =>
	(buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);

const readUint32BE = (buffer: Uint8Array, offset: number): number =>
	(buffer[offset] ?? 0) * 0x1000000 +
	((buffer[offset + 1] ?? 0) << 16) +
	((buffer[offset + 2] ?? 0) << 8) +
	(buffer[offset + 3] ?? 0);

const readUint32LE = (buffer: Uint8Array, offset: number): number =>
	(buffer[offset] ?? 0) +
	((buffer[offset + 1] ?? 0) << 8) +
	((buffer[offset + 2] ?? 0) << 16) +
	(buffer[offset + 3] ?? 0) * 0x1000000;

const startsWith = (buffer: Uint8Array, bytes: ReadonlyArray<number>): boolean =>
	buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);

const startsWithAscii = (buffer: Uint8Array, offset: number, text: string): boolean => {
	if (buffer.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
};
