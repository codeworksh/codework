import { describe, expect, it } from "vite-plus/test";
import { Accumulator } from "../src/tool/accumulator.ts";

const accumulate = (text: string, options: { maxLines: number; maxBytes: number }) => {
	const acc = new Accumulator(options);
	// Single-byte chunks split every multibyte UTF-8 code point.
	for (const byte of Buffer.from(text)) acc.append(Buffer.from([byte]));
	acc.finish();
	return acc.snapshot();
};

describe("tool output retention", () => {
	it("keeps UTF-8 intact at the exact byte limit without truncating", () => {
		const text = "🙂é\n";
		const snapshot = accumulate(text, { maxLines: 1, maxBytes: Buffer.byteLength(text) });
		expect(snapshot.content).toBe(text);
		expect(snapshot.truncation.truncated).toBe(false);
	});

	it("retains the ordered tail", () => {
		const snapshot = accumulate("first\nsecond\n第三\n🙂last\n", { maxLines: 2, maxBytes: 100 });
		expect(snapshot.content).toBe("第三\n🙂last");
		expect(snapshot.truncation).toMatchObject({ truncated: true, truncatedBy: "lines", totalLines: 4 });
	});

	it("bounds an oversized unterminated Unicode line without replacement characters", () => {
		const text = "🙂".repeat(100);
		const snapshot = accumulate(text, { maxLines: 2, maxBytes: 17 });
		expect(snapshot.content).toBe("🙂".repeat(4));
		expect(Buffer.byteLength(snapshot.content)).toBeLessThanOrEqual(17);
		expect(snapshot.truncation).toMatchObject({ truncated: true, truncatedBy: "bytes", lastLinePartial: true });
	});
});
