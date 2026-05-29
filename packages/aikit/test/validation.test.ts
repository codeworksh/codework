import Type, { type TSchema } from "typebox";
import { describe, expect, it } from "vite-plus/test";
import { Message as PublicMessage } from "../src/index";
import { Message } from "../src/message/message";
import { validateToolArguments, validateToolCall } from "../src/utils/validation";

function createToolCallWithSchema(
	schema: TSchema,
	value: unknown,
): {
	tool: Message.Tool;
	toolCall: Message.ToolCallInFlight;
} {
	const tool: Message.Tool = {
		name: "echo",
		description: "Echo tool",
		parameters: Type.Object({
			value: schema,
		}),
	};

	const toolCall: Message.ToolCallInFlight = {
		callID: "tool-1",
		name: "echo",
		rawArgs: { value },
	};

	return { tool, toolCall };
}

describe("validateToolArguments", () => {
	describe("internal data model", () => {
		it("still validates when Function constructor is unavailable", () => {
			const originalFunction = globalThis.Function;
			const tool: Message.Tool = {
				name: "echo",
				description: "Echo tool",
				parameters: Type.Object({
					count: Type.Number(),
				}),
			};
			const toolCall: Message.ToolCallInFlight = {
				callID: "tool-1",
				name: "echo",
				rawArgs: { count: "42" },
			};

			globalThis.Function = (() => {
				throw new EvalError("Code generation from strings disallowed for this context");
			}) as unknown as FunctionConstructor;

			try {
				expect(validateToolArguments(tool, toolCall)).toEqual({ count: 42 });
			} finally {
				globalThis.Function = originalFunction;
			}
		});

		it("coerces TypeBox schemas with TypeBox-compatible primitive rules", () => {
			const passingCases: Array<{
				schema: TSchema;
				input: unknown;
				expected: unknown;
			}> = [
				{ schema: Type.Number(), input: "42", expected: 42 },
				{ schema: Type.Number(), input: true, expected: 1 },
				{ schema: Type.Number(), input: null, expected: 0 },
				{ schema: Type.Integer(), input: "42", expected: 42 },
				{ schema: Type.Boolean(), input: "true", expected: true },
				{ schema: Type.Boolean(), input: "false", expected: false },
				{ schema: Type.Boolean(), input: 1, expected: true },
				{ schema: Type.Boolean(), input: 0, expected: false },
				{ schema: Type.String(), input: null, expected: "null" },
				{ schema: Type.String(), input: true, expected: "true" },
				{ schema: Type.Null(), input: "", expected: null },
				{ schema: Type.Null(), input: 0, expected: null },
				{ schema: Type.Null(), input: false, expected: null },
				{
					schema: Type.Union([Type.Number(), Type.String()]),
					input: "1",
					expected: "1",
				},
				{
					schema: Type.Union([Type.Number(), Type.Boolean()]),
					input: "1",
					expected: 1,
				},
			];

			for (const testCase of passingCases) {
				const { tool, toolCall } = createToolCallWithSchema(testCase.schema, testCase.input);
				expect(validateToolArguments(tool, toolCall)).toEqual({ value: testCase.expected });
			}
		});

		it("rejects invalid coercions for TypeBox schemas", () => {
			const failingCases: Array<{
				schema: TSchema;
				input: unknown;
			}> = [
				{ schema: Type.Number(), input: "not-a-number" },
				{ schema: Type.Integer(), input: "not-an-integer" },
				{ schema: Type.Boolean(), input: "yes" },
				{ schema: Type.Null(), input: "not-null" },
			];

			for (const testCase of failingCases) {
				const { tool, toolCall } = createToolCallWithSchema(testCase.schema, testCase.input);
				expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation Failed");
			}
		});

		it("finds a matching tool and validates an in-flight tool call", () => {
			const tool = Message.defineTool({
				name: "search",
				description: "Search documents",
				parameters: Type.Object({
					query: Type.String(),
					limit: Type.Optional(Type.Number()),
					includeArchived: Type.Optional(Type.Boolean()),
				}),
			});
			const toolCall: Message.ToolCallInFlight = {
				callID: "tool-1",
				name: "search",
				rawArgs: {
					query: "unicode",
					limit: "5",
					includeArchived: "false",
				},
			};

			expect(validateToolCall([tool], toolCall)).toEqual({
				query: "unicode",
				limit: 5,
				includeArchived: false,
			});
		});
	});

	describe("exposed interface", () => {
		it("validates tools defined through the public Message interface", () => {
			const tool = PublicMessage.defineTool({
				name: "echo",
				description: "Echo tool",
				parameters: Type.Object({
					count: Type.Number(),
					enabled: Type.Boolean(),
				}),
			});
			const toolCall: Message.ToolCallInFlight = {
				callID: "tool-1",
				name: "echo",
				rawArgs: {
					count: "7",
					enabled: "true",
				},
			};

			expect(validateToolArguments(tool, toolCall)).toEqual({
				count: 7,
				enabled: true,
			});
		});
	});
});
