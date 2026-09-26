import { describe, expect, it } from "vite-plus/test";
import { sanitizeSurrogates } from "../src/utils/sanitize.ts";

describe("sanitizeSurrogates", () => {
	it("removes an unpaired high surrogate", () => {
		const unpaired = String.fromCharCode(0xd83d);
		expect(sanitizeSurrogates(`Text ${unpaired} here`)).toBe("Text  here");
	});

	it("removes an unpaired low surrogate", () => {
		const unpaired = String.fromCharCode(0xde48);
		expect(sanitizeSurrogates(`Text ${unpaired} here`)).toBe("Text  here");
	});

	it("removes consecutive unpaired surrogates of the same kind", () => {
		const doubleHigh = String.fromCharCode(0xd83d, 0xd83d);
		expect(sanitizeSurrogates(`a${doubleHigh}b`)).toBe("ab");
	});

	it("keeps the valid pair when an unpaired high surrogate precedes an emoji", () => {
		const input = `a${String.fromCharCode(0xd83d)}🙈b`;
		expect(sanitizeSurrogates(input)).toBe("a🙈b");
	});
});
