import type { SandboxFileSystem } from "../../src/sandbox/fs/filesystem.ts";

/**
 * Files and windows every `scanLines` implementation must agree on, plus a
 * reference that computes the expected result the obvious way — whole file in
 * memory, split, slice — independently of the streaming scanner it checks.
 */

const utf8 = (text: string) => new TextEncoder().encode(text);

export const files: Record<string, Uint8Array> = {
	empty: utf8(""),
	newline: utf8("\n"),
	noTrailingNewline: utf8("a\nb"),
	trailingNewline: utf8("a\nb\n"),
	blankLines: utf8("a\n\n\nb\n"),
	crlf: utf8("one\r\ntwo\r\n"),
	bom: utf8("\uFEFFfirst\nsecond\n"),
	bomOnly: utf8("\uFEFF"),
	doubleBom: utf8("\uFEFF\uFEFFtext\n"),
	bomMidFile: utf8("a\n\uFEFFb\n"),
	shortLikeBom: new Uint8Array([0xef, 0xbb]),
	multibyte: utf8("héllo\n🚀🚀\nwörld"),
	longFirstLine: utf8(`${"x".repeat(100)}\nshort\n`),
	percent: utf8("100% %d %s\n\\n stays\n"),
	trailingSpaces: utf8("keep   \n  these  "),
	// Larger than one 64 KiB read, so a reader that reuses its buffer must not
	// overwrite lines already selected.
	pastOneRead: utf8(`one\ntwo\n${"x".repeat(70_000)}\nend\n`),
	manyLines: utf8(Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n")),
};

export const windows: ReadonlyArray<SandboxFileSystem.LineScanOptions> = [
	{ startLine: 0, maxBytes: 10_000 },
	{ startLine: 1, maxBytes: 10_000 },
	{ startLine: 1, endLine: 2, maxBytes: 10_000 },
	{ startLine: 0, maxBytes: 6 },
	{ startLine: 0, maxBytes: 1 },
	{ startLine: 10, endLine: 20, maxBytes: 40 },
	{ startLine: 1000, maxBytes: 10_000 },
];

const NEWLINE = 0x0a;

export const reference = (
	bytes: Uint8Array,
	options: SandboxFileSystem.LineScanOptions,
): SandboxFileSystem.LineScan => {
	const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
	const body = bom ? bytes.subarray(3) : bytes;
	const lines: Array<Uint8Array> = [];
	let from = 0;
	for (let index = 0; index <= body.length; index++) {
		if (index === body.length || body[index] === NEWLINE) {
			lines.push(body.subarray(from, index));
			from = index + 1;
		}
	}
	// A trailing newline ends the last line rather than starting another.
	if (lines.at(-1)?.length === 0) lines.pop();

	const selected = lines.slice(options.startLine, options.endLine);
	const kept: Array<Uint8Array> = [];
	let used = 0;
	for (const line of selected) {
		const added = kept.length === 0 ? line.length : line.length + 1;
		if (used + added > options.maxBytes) break;
		kept.push(line);
		used += added;
	}
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	return {
		text: kept.map((line) => decoder.decode(line)).join("\n"),
		lines: kept.length,
		totalLines: lines.length,
		totalBytes: bytes.length,
		firstLineBytes: selected[0]?.length ?? 0,
	};
};

export const label = (options: SandboxFileSystem.LineScanOptions) =>
	`${options.startLine}..${options.endLine ?? "end"} max ${options.maxBytes}`;
