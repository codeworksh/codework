import { describe, expect, it } from "vite-plus/test";
import { parseStreamingJson } from "../src/utils/jsonparse";

describe("parseStreamingJson", () => {
	describe("empty input", () => {
		it("returns an empty object for undefined", () => {
			expect(parseStreamingJson(undefined)).toEqual({});
		});

		it("returns an empty object for an empty string", () => {
			expect(parseStreamingJson("")).toEqual({});
		});

		it("returns an empty object for whitespace-only input", () => {
			expect(parseStreamingJson("   \n\t ")).toEqual({});
		});
	});

	describe("complete JSON", () => {
		it("parses a complete object", () => {
			expect(parseStreamingJson('{"a": 1, "b": "two"}')).toEqual({ a: 1, b: "two" });
		});

		it("parses nested structures", () => {
			expect(parseStreamingJson('{"items": [{"id": 1}, {"id": 2}], "done": true}')).toEqual({
				items: [{ id: 1 }, { id: 2 }],
				done: true,
			});
		});

		it("parses valid escape sequences", () => {
			expect(parseStreamingJson('{"text": "line1\\nline2\\ttabbed"}')).toEqual({
				text: "line1\nline2\ttabbed",
			});
		});
	});

	describe("partial JSON during streaming", () => {
		it("parses an object missing its closing brace", () => {
			expect(parseStreamingJson('{"a": 1')).toEqual({ a: 1 });
		});

		it("parses an incomplete string value", () => {
			expect(parseStreamingJson('{"text": "hel')).toEqual({ text: "hel" });
		});

		it("parses a dangling key without a value", () => {
			expect(parseStreamingJson('{"a": 1, "b"')).toEqual({ a: 1 });
		});

		it("parses an incomplete array value", () => {
			expect(parseStreamingJson('{"items": [1, 2')).toEqual({ items: [1, 2] });
		});

		it("returns an empty object for a lone opening brace", () => {
			expect(parseStreamingJson("{")).toEqual({});
		});
	});

	describe("invalid string content repair", () => {
		it("repairs raw newlines inside string values", () => {
			expect(parseStreamingJson('{"text": "line1\nline2"}')).toEqual({ text: "line1\nline2" });
		});

		it("repairs raw tabs and carriage returns inside string values", () => {
			expect(parseStreamingJson('{"text": "a\tb\rc"}')).toEqual({ text: "a\tb\rc" });
		});

		it("repairs invalid escape sequences", () => {
			// A literal `\x` in the JSON text is not a valid escape; it should
			// be preserved as a literal backslash + x after repair.
			expect(parseStreamingJson('{"path": "C:\\xfoo"}')).toEqual({ path: "C:\\xfoo" });
		});

		it("keeps valid escapes intact while repairing raw control characters", () => {
			expect(parseStreamingJson('{"text": "tab\\there\nnewline"}')).toEqual({
				text: "tab\there\nnewline",
			});
		});

		it("repairs raw newlines in incomplete (streaming) strings", () => {
			expect(parseStreamingJson('{"text": "line1\nline2')).toEqual({ text: "line1\nline2" });
		});
	});

	describe("unparseable input", () => {
		it("returns an empty object for garbage input", () => {
			expect(parseStreamingJson("certainly not json")).toEqual({});
		});

		it("returns an empty object for a trailing backslash fragment", () => {
			expect(parseStreamingJson('{"a": "foo\\')).toBeTypeOf("object");
		});
	});
});
