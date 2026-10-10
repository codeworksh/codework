import type { Photon, PhotonImage } from "./photon.ts";

/**
 * EXIF orientation for JPEG and WebP. Photon decodes pixels as stored, so a phone
 * photo taken sideways would reach the model sideways without this.
 */

const readOrientationFromTiff = (bytes: Uint8Array, tiffStart: number): number => {
	if (tiffStart + 8 > bytes.length) return 1;
	const le = ((byte(bytes, tiffStart) << 8) | byte(bytes, tiffStart + 1)) === 0x4949;
	const read16 = (pos: number): number =>
		le ? byte(bytes, pos) | (byte(bytes, pos + 1) << 8) : (byte(bytes, pos) << 8) | byte(bytes, pos + 1);
	const read32 = (pos: number): number =>
		le
			? (byte(bytes, pos) |
					(byte(bytes, pos + 1) << 8) |
					(byte(bytes, pos + 2) << 16) |
					(byte(bytes, pos + 3) << 24)) >>>
				0
			: ((byte(bytes, pos) << 24) |
					(byte(bytes, pos + 1) << 16) |
					(byte(bytes, pos + 2) << 8) |
					byte(bytes, pos + 3)) >>>
				0;

	const ifdStart = tiffStart + read32(tiffStart + 4);
	if (ifdStart + 2 > bytes.length) return 1;
	const entryCount = read16(ifdStart);
	for (let index = 0; index < entryCount; index++) {
		const entryPos = ifdStart + 2 + index * 12;
		if (entryPos + 12 > bytes.length) return 1;
		if (read16(entryPos) === 0x0112) {
			const value = read16(entryPos + 8);
			return value >= 1 && value <= 8 ? value : 1;
		}
	}
	return 1;
};

const findJpegTiffOffset = (bytes: Uint8Array): number => {
	let offset = 2;
	while (offset < bytes.length - 1) {
		if (bytes[offset] !== 0xff) return -1;
		const marker = bytes[offset + 1];
		if (marker === 0xff) {
			offset++;
			continue;
		}
		if (marker === 0xe1) {
			const segmentStart = offset + 4;
			if (segmentStart + 6 > bytes.length) return -1;
			if (hasExifHeader(bytes, segmentStart)) return segmentStart + 6;
		}
		if (offset + 4 > bytes.length) return -1;
		offset += 2 + ((byte(bytes, offset + 2) << 8) | byte(bytes, offset + 3));
	}
	return -1;
};

const findWebpTiffOffset = (bytes: Uint8Array): number => {
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const chunkId = String.fromCharCode(...bytes.subarray(offset, offset + 4));
		const chunkSize =
			byte(bytes, offset + 4) |
			(byte(bytes, offset + 5) << 8) |
			(byte(bytes, offset + 6) << 16) |
			(byte(bytes, offset + 7) << 24);
		const dataStart = offset + 8;
		if (chunkId === "EXIF") {
			if (dataStart + chunkSize > bytes.length) return -1;
			// Some WebP files carry an "Exif\0\0" prefix before the TIFF header.
			return chunkSize >= 6 && hasExifHeader(bytes, dataStart) ? dataStart + 6 : dataStart;
		}
		// RIFF chunks are padded to an even size.
		offset = dataStart + chunkSize + (chunkSize % 2);
	}
	return -1;
};

const hasExifHeader = (bytes: Uint8Array, offset: number): boolean =>
	[0x45, 0x78, 0x69, 0x66, 0x00, 0x00].every((value, index) => bytes[offset + index] === value);

const orientationOf = (bytes: Uint8Array): number => {
	let tiffOffset = -1;
	if (bytes[0] === 0xff && bytes[1] === 0xd8) tiffOffset = findJpegTiffOffset(bytes);
	else if (
		String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
		String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
	)
		tiffOffset = findWebpTiffOffset(bytes);
	return tiffOffset === -1 ? 1 : readOrientationFromTiff(bytes, tiffOffset);
};

const byte = (bytes: Uint8Array, index: number): number => bytes[index] ?? 0;

type DstIndex = (x: number, y: number, w: number, h: number) => number;

const rotate90 = (photon: Photon, image: PhotonImage, dstIndex: DstIndex): PhotonImage => {
	const w = image.get_width();
	const h = image.get_height();
	const src = image.get_raw_pixels();
	const dst = new Uint8Array(src.length);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			dst.set(src.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), dstIndex(x, y, w, h) * 4);
		}
	}
	return new photon.PhotonImage(dst, h, w);
};

const clockwise: DstIndex = (x, y, _w, h) => x * h + (h - 1 - y);
const counterClockwise: DstIndex = (x, y, w, h) => (w - 1 - x) * h + y;

/** Flips mutate `image`; rotations return a new image, which the caller frees alongside the old one. */
export const applyOrientation = (photon: Photon, image: PhotonImage, originalBytes: Uint8Array): PhotonImage => {
	switch (orientationOf(originalBytes)) {
		case 2:
			photon.fliph(image);
			return image;
		case 3:
			photon.fliph(image);
			photon.flipv(image);
			return image;
		case 4:
			photon.flipv(image);
			return image;
		case 5: {
			const rotated = rotate90(photon, image, clockwise);
			photon.fliph(rotated);
			return rotated;
		}
		case 6:
			return rotate90(photon, image, clockwise);
		case 7: {
			const rotated = rotate90(photon, image, counterClockwise);
			photon.fliph(rotated);
			return rotated;
		}
		case 8:
			return rotate90(photon, image, counterClockwise);
		default:
			return image;
	}
};
