import { describe, expect, it } from "vite-plus/test";
import { sanitizeSurrogates } from "../src/utils/sanitize";

describe("sanitizeSurrogates", () => {
	it("leaves plain ASCII untouched", () => {
		expect(sanitizeSurrogates("Hello world")).toBe("Hello world");
	});

	it("preserves properly paired surrogates (emoji)", () => {
		expect(sanitizeSurrogates("Hello 🙈 World 🚀")).toBe("Hello 🙈 World 🚀");
	});

	it("preserves BMP characters and combining sequences", () => {
		expect(sanitizeSurrogates("करें चाय पे चर्चा こんにちは 你好 ❤️")).toBe("करें चाय पे चर्चा こんにちは 你好 ❤️");
	});

	it("removes an unpaired high surrogate", () => {
		const unpaired = String.fromCharCode(0xd83d);
		expect(sanitizeSurrogates(`Text ${unpaired} here`)).toBe("Text  here");
	});

	it("removes an unpaired low surrogate", () => {
		const unpaired = String.fromCharCode(0xde48);
		expect(sanitizeSurrogates(`Text ${unpaired} here`)).toBe("Text  here");
	});

	it("removes a high surrogate at the end of the string", () => {
		const unpaired = String.fromCharCode(0xd800);
		expect(sanitizeSurrogates(`truncated emoji ${unpaired}`)).toBe("truncated emoji ");
	});

	it("removes a low surrogate at the start of the string", () => {
		const unpaired = String.fromCharCode(0xdfff);
		expect(sanitizeSurrogates(`${unpaired} leading garbage`)).toBe(" leading garbage");
	});

	it("removes consecutive unpaired surrogates of the same kind", () => {
		const doubleHigh = String.fromCharCode(0xd83d, 0xd83d);
		expect(sanitizeSurrogates(`a${doubleHigh}b`)).toBe("ab");
	});

	it("keeps the valid pair when an unpaired high surrogate precedes an emoji", () => {
		const input = `a${String.fromCharCode(0xd83d)}🙈b`;
		expect(sanitizeSurrogates(input)).toBe("a🙈b");
	});

	it("handles the empty string", () => {
		expect(sanitizeSurrogates("")).toBe("");
	});
});
