import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { readTool } from "../src/plugin/builtin/tool/read.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { Local } from "../src/sandbox/fs/vfs.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import { HostExe } from "../src/sandbox/shell/host.ts";
import * as Executor from "../src/tool/executor.ts";
import * as Tool from "../src/tool/tool.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "../src/tool/truncate.ts";
import { pendingCall } from "./tools.fixture.ts";

/**
 * `read` before bounded reads, kept as the reference: decode the whole file,
 * split it into lines (a trailing newline ends the last line; a leading BOM is
 * not text), and truncate the selection. The tool must answer the same while
 * reading only the window through `scanLines`.
 */
const referenceRead = (bytes: Uint8Array, path: string, offset: number | undefined, limit: number | undefined) => {
	const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
	const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
	const lines = text === "" ? [] : text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	const startLine = offset ? Math.max(0, Math.trunc(offset) - 1) : 0;
	const first = startLine + 1;
	const max = limit === undefined ? undefined : Math.max(1, Math.trunc(limit));
	if (startLine >= Math.max(lines.length, 1)) {
		return { error: `Offset ${offset} is beyond end of file (${lines.length} lines total)` };
	}
	const selected = lines.slice(startLine, max === undefined ? undefined : startLine + max);
	const truncation = truncateHead(selected.join("\n"));
	if (truncation.firstLineExceedsLimit) {
		const size = formatSize(new TextEncoder().encode(selected[0]).byteLength);
		return {
			text: `[Line ${first} is ${size}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${first}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`,
		};
	}
	if (truncation.truncated) {
		const last = startLine + truncation.outputLines;
		const limitText = truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
		return {
			text: `${truncation.content}\n\n[Showing lines ${first}-${last} of ${lines.length}${limitText}. Use offset=${last + 1} to continue.]`,
		};
	}
	if (max !== undefined && startLine + max < lines.length) {
		const remaining = lines.length - (startLine + max);
		return {
			text: `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${startLine + max + 1} to continue.]`,
		};
	}
	return { text: truncation.content };
};

/** Deterministic PRNG (mulberry32), so a failing seed reproduces. */
const random = (seed: number): (() => number) => {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

// Newlines, ASCII, BOMs mid-file, multi-byte characters, a truncated sequence, an invalid byte, CRLF.
const PIECES = [
	[0x0a],
	[0x0a],
	[0x61],
	[0x62, 0x63, 0x64, 0x65],
	[0xef, 0xbb, 0xbf],
	[0xc3, 0xa9],
	[0xe2, 0x82, 0xac],
	[0xf0, 0x9f, 0x98, 0x80],
	[0xe2, 0x82],
	[0xff],
	[0x0d, 0x0a],
];

/** Mostly small files, some over the line limit, some over the byte limit, some with one huge line. */
const randomFile = (next: () => number): Uint8Array => {
	const kind = next();
	if (kind < 0.1) return Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("x\n".repeat(2100))]);
	if (kind < 0.2) {
		const line = new Uint8Array(DEFAULT_MAX_BYTES + 200 + Math.floor(next() * 400)).fill(0x61);
		line[DEFAULT_MAX_BYTES - 1 + Math.floor(next() * 3)] = 0xc3;
		return Uint8Array.from([...line, 0x0a, 0x62]);
	}
	if (kind < 0.3) return new TextEncoder().encode(`${"0123456789".repeat(30)}\n`.repeat(200));
	// Invalid bytes decode to three-byte U+FFFD each: under the byte limit raw, over it decoded.
	if (kind < 0.35)
		return Uint8Array.from([...new Uint8Array(20_000 + Math.floor(next() * 20_000)).fill(0xff), 0x0a, 0x62]);
	const bytes: Array<number> = [];
	const pieces = Math.floor(next() * 80);
	for (let index = 0; index < pieces; index++) bytes.push(...PIECES[Math.floor(next() * PIECES.length)]!);
	return Uint8Array.from(bytes);
};

const OFFSETS = [undefined, 0, 1, 2, 3, 5, 50, 199, 200, 201, 2000, 2001, 2101, 2102, 1e20];
const LIMITS = [undefined, 1, 2, 3, 10, 100, 2000, 2500];

// The in-memory VFS mounted at `/`, the same mount path production takes.
const mounted = Layer.provideMerge(
	SandboxIO.mount(SandboxIO.host("/")),
	Layer.provideMerge(Layer.merge(Local.layer, HostExe.layer()), Sandbox.EnvInMemory.layer()),
);

describe("read tool", () => {
	it(
		"returns exactly what reading the whole file returned",
		() =>
			Effect.gen(function* () {
				const fs = yield* SandboxIO.FileSystem;
				const executor = Executor.make([Tool.provide(readTool, Layer.succeed(SandboxIO.FileSystem, fs))]);
				for (let seed = 1; seed <= 400; seed++) {
					const next = random(seed);
					const file = randomFile(next);
					yield* fs.writeFile("/f.txt", file);
					for (let trial = 0; trial < 4; trial++) {
						const offset = OFFSETS[Math.floor(next() * OFFSETS.length)];
						const limit = LIMITS[Math.floor(next() * LIMITS.length)];
						const args = {
							path: "f.txt",
							...(offset === undefined ? {} : { offset }),
							...(limit === undefined ? {} : { limit }),
						};
						const outcome = yield* executor.handle(pendingCall("read", args));
						const part = outcome.result.content[0];
						const text = part?.type === "text" ? part.text : undefined;
						const actual = outcome.status === "error" ? { error: text } : { text };
						expect(actual, `seed ${seed} offset ${offset} limit ${limit}`).toEqual(
							referenceRead(file, "f.txt", offset, limit),
						);
					}
				}
			}).pipe(Effect.provide(mounted), Effect.runPromise),
		120_000,
	);
});
