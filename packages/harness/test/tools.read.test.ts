import "./utils/env.ts";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { Effect } from "effect";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { readPlugin } from "../src/plugin/builtin/tool/read.ts";
import { toolTurn } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";
import { pendingCall } from "./tools.fixture.ts";

const png = (width: number, height: number) =>
	new Uint8Array(new PhotonImage(new Uint8Array(width * height * 4).fill(200), width, height).get_bytes());

/** A 2x2 24-bit BMP: 54 header bytes, then two rows padded to 8 bytes. */
const bmp = () => {
	const bytes = Buffer.alloc(54 + 16);
	bytes.write("BM", 0, "ascii");
	bytes.writeUInt32LE(bytes.length, 2);
	bytes.writeUInt32LE(54, 10);
	bytes.writeUInt32LE(40, 14);
	bytes.writeInt32LE(2, 18);
	bytes.writeInt32LE(2, 22);
	bytes.writeUInt16LE(1, 26);
	bytes.writeUInt16LE(24, 28);
	bytes.writeUInt32LE(16, 34);
	bytes.fill(0x7f, 54);
	return new Uint8Array(bytes);
};

/** A PNG with an `acTL` chunk before its first `IDAT`: animated, so not an inline image. */
const apng = () => {
	const still = Buffer.from(png(2, 2));
	const acTL = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from("acTL"), Buffer.alloc(8), Buffer.alloc(4)]);
	// The signature (8) plus IHDR (4 length + 4 type + 13 data + 4 CRC) ends at 33.
	return new Uint8Array(Buffer.concat([still.subarray(0, 33), acTL, still.subarray(33)]));
};

/** A JPEG stored landscape whose EXIF says "rotate 90° clockwise" (orientation 6). */
const rotatedJpeg = (width: number, height: number) => {
	const jpeg = Buffer.from(
		new PhotonImage(new Uint8Array(width * height * 4).fill(90), width, height).get_bytes_jpeg(80),
	);
	const tiff = Buffer.from([
		...Buffer.from("MM\0*", "binary"),
		0,
		0,
		0,
		8, // first IFD
		0,
		1, // one entry
		0x01,
		0x12,
		0,
		3,
		0,
		0,
		0,
		1,
		0,
		6,
		0,
		0, // Orientation, SHORT, 1, value 6
		0,
		0,
		0,
		0, // no next IFD
	]);
	const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
	const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, payload.length + 2]), payload]);
	return new Uint8Array(Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
};

const numbered = (count: number, width = 0) =>
	Array.from({ length: count }, (_, index) => `line ${index + 1}`.padEnd(width, ".")).join("\n") + "\n";

/** Each case: the file it needs (if any) and the arguments of one `read` call. */
const cases: ReadonlyArray<{
	readonly name: string;
	readonly file?: readonly [string, string | Uint8Array];
	readonly args: Record<string, unknown>;
}> = [
	{ name: "text", file: ["hello.txt", "alpha\nbeta\n"], args: { path: "hello.txt" } },
	{ name: "empty", file: ["empty.txt", ""], args: { path: "empty.txt" } },
	{ name: "bom", file: ["bom.txt", "﻿first\nsecond"], args: { path: "bom.txt" } },
	{ name: "offset-limit", file: ["ten.txt", numbered(10)], args: { path: "ten.txt", offset: 3, limit: 2 } },
	{ name: "limit-to-end", file: ["three.txt", numbered(3)], args: { path: "three.txt", offset: 2, limit: 5 } },
	{ name: "line-limit", file: ["long.txt", numbered(2500)], args: { path: "long.txt" } },
	{ name: "line-limit-offset", args: { path: "long.txt", offset: 2001 } },
	{ name: "exactly-line-limit", file: ["exact.txt", numbered(2000)], args: { path: "exact.txt" } },
	{ name: "byte-limit", file: ["wide.txt", numbered(1000, 99)], args: { path: "wide.txt" } },
	{
		name: "first-line-too-long",
		file: ["huge-line.txt", `${"x".repeat(60 * 1024)}\nend\n`],
		args: { path: "huge-line.txt" },
	},
	{ name: "offset-past-end", args: { path: "three.txt", offset: 4 } },
	{ name: "offset-huge", args: { path: "three.txt", offset: 1e20 } },
	{ name: "missing", args: { path: "missing.txt" } },
	{ name: "directory", file: ["dir/inside.txt", "x"], args: { path: "dir" } },
	{
		name: "binary",
		file: ["blob.bin", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3])],
		args: { path: "blob.bin" },
	},
	{ name: "gif-text", file: ["gif.txt", "GIF is not an image\n"], args: { path: "gif.txt" } },
	{ name: "fake-png", file: ["fake.png", "definitely not a png\n"], args: { path: "fake.png" } },
	{ name: "png", file: ["dot.png", png(4, 3)], args: { path: "dot.png" } },
	{ name: "png-resized", file: ["wide.png", png(3000, 1000)], args: { path: "wide.png" } },
	{ name: "png-thin", file: ["thin.png", png(5000, 1)], args: { path: "thin.png" } },
	{ name: "bmp-converted", file: ["tiny.bmp", bmp()], args: { path: "tiny.bmp" } },
	{ name: "apng", file: ["moving.png", apng()], args: { path: "moving.png" } },
	{ name: "jpeg-exif-rotated", file: ["photo.jpg", rotatedJpeg(3000, 1000)], args: { path: "photo.jpg" } },
	{ name: "unreadable", file: ["secret.txt", "hidden\n"], args: { path: "secret.txt" } },
	{ name: "at-prefix", args: { path: "@hello.txt" } },
	{ name: "unicode-space", file: ["two words.txt", "spaced\n"], args: { path: "two words.txt" } },
	{ name: "nfd-name", file: ["cafe\u0301.txt", "accented\n"], args: { path: "caf\u00e9.txt" } },
	{ name: "curly-quote-name", file: ["it\u2019s.txt", "quoted\n"], args: { path: "it's.txt" } },
	{
		name: "screenshot-name-lowercase",
		file: ["Screenshot 2026-10-10 at 9.41.12\u202Fam.txt", "en_AU\n"],
		args: { path: "Screenshot 2026-10-10 at 9.41.12 am.txt" },
	},
	{
		name: "screenshot-name",
		file: ["Screenshot 2026-10-10 at 9.41.12 AM.png", png(2, 2)],
		args: { path: "Screenshot 2026-10-10 at 9.41.12 AM.png" },
	},
];

/** Every case as one turn of parallel `read` calls through plugin setup, the local mount, and durable settlement. */
const readAll = (root: string, custom: string) =>
	Effect.gen(function* () {
		const session = yield* Session.create({ directory: root, model: { provider: "openai", id: "gpt-5.6-luna" } });
		yield* session.run("Read the files.");
		const path = yield* session.path();
		expect(path.every((entry) => entry.entry.state === "committed")).toBe(true);
		const messages = yield* Effect.forEach(path, ContextCodec.decodeMessage);
		return messages.flatMap((message) => message.parts.filter((part) => part.type === "toolCall"));
	}).pipe(
		Effect.provide(
			Harness.layer({
				home: join(root, "home"),
				hostCwd: root,
				userConfigDir: custom,
				database: ":memory:",
				plugins: [readPlugin, defaultPromptPlugin],
				llm: toolTurn(...cases.map((entry) => pendingCall("read", entry.args, entry.name))),
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

/** Image bytes are summarised: the artifact records what the model got, not the pixels. */
const summarise = (content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }>) =>
	content.map((part) =>
		part.type === "image"
			? { type: "image", mimeType: part.mimeType, base64Bytes: part.data?.length }
			: {
					type: part.type,
					text:
						part.text !== undefined && part.text.length > 400
							? `${part.text.slice(0, 120)}…${part.text.slice(-200)}`
							: part.text,
				},
	);

describe("read plugin through the local harness", () => {
	it("reads text, pages, images and failures like Pi", () =>
		withSettings(async ({ root, custom }) => {
			for (const { file } of cases) {
				if (file === undefined) continue;
				await mkdir(join(root, file[0], ".."), { recursive: true });
				await writeFile(join(root, file[0]), file[1]);
			}
			await chmod(join(root, "secret.txt"), 0o000);

			const calls = await readAll(root, custom);
			const report = Object.fromEntries(
				cases.map(({ name }) => {
					const call = calls.find((part) => part.type === "toolCall" && part.callID === name);
					if (call?.type !== "toolCall" || (call.status !== "completed" && call.status !== "error"))
						throw new Error(`${name} was not settled`);
					return [
						name,
						{
							status: call.status,
							content: summarise(call.result.content),
							...(call.result.details === undefined ? {} : { details: call.result.details }),
						},
					];
				}),
			);

			// Errors name absolute paths; the artifact names them under `<root>`.
			const json = JSON.stringify(report, null, "\t")
				.replaceAll(await realpath(root), "<root>")
				.replaceAll(root, "<root>");
			await expect(json + "\n").toMatchFileSnapshot("./__artifacts__/tools.read.json");
		}));
});
