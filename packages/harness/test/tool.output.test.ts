import { Effect } from "effect";
import { readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { Accumulator } from "../src/tool/accumulator.ts";
import { truncateTail } from "../src/tool/truncate.ts";

const accumulate = async (text: string, options: { maxLines: number; maxBytes: number }) => {
	const acc = new Accumulator(options);
	try {
		return await Effect.runPromise(
			Effect.gen(function* () {
				// Single-byte chunks split every multibyte UTF-8 code point.
				for (const byte of Buffer.from(text)) yield* acc.append(Buffer.from([byte]));
				yield* acc.finish();
				const snapshot = acc.snapshot();
				const full =
					snapshot.fullOutputPath === undefined
						? undefined
						: yield* Effect.promise(() => readFile(snapshot.fullOutputPath!, "utf8"));
				return { snapshot, full };
			}).pipe(Effect.scoped),
		);
	} finally {
		const path = acc.snapshot().fullOutputPath;
		if (path !== undefined) await rm(path, { force: true });
	}
};

describe("tool output retention", () => {
	it("keeps UTF-8 intact at the exact byte limit without spilling", async () => {
		const text = "🙂é\n";
		const { snapshot, full } = await accumulate(text, { maxLines: 1, maxBytes: Buffer.byteLength(text) });
		expect(snapshot.content).toBe(text);
		expect(snapshot.truncation.truncated).toBe(false);
		expect(full).toBeUndefined();
	});

	it("retains the ordered tail and every original byte after incremental spilling", async () => {
		const text = "first\nsecond\n第三\n🙂last\n";
		const { snapshot, full } = await accumulate(text, { maxLines: 2, maxBytes: 100 });
		expect(snapshot.content).toBe("第三\n🙂last");
		expect(snapshot.truncation).toMatchObject({ truncated: true, truncatedBy: "lines", totalLines: 4 });
		expect(full).toBe(text);
	});

	it("bounds an oversized unterminated Unicode line without replacement characters", async () => {
		const text = "🙂".repeat(100);
		const { snapshot, full } = await accumulate(text, { maxLines: 2, maxBytes: 17 });
		expect(snapshot.content).toBe("🙂".repeat(4));
		expect(Buffer.byteLength(snapshot.content)).toBeLessThanOrEqual(17);
		expect(snapshot.truncation).toMatchObject({ truncated: true, truncatedBy: "bytes", lastLinePartial: true });
		expect(full).toBe(text);
	});

	it("applies the first reached line or byte bound to buffered output", () => {
		expect(truncateTail("one\ntwo\nthree\n", { maxLines: 2, maxBytes: 100 })).toMatchObject({
			content: "two\nthree",
			truncatedBy: "lines",
		});
		expect(truncateTail("one\ntwo\nthree\n", { maxLines: 100, maxBytes: 6 })).toMatchObject({
			content: "three",
			truncatedBy: "bytes",
		});
	});
});
