import { Cause, Effect, Exit, Option, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { bashDef } from "../src/tools/bash.ts";
import { ToolExecutionError } from "../src/tools/error.ts";
import * as Executor from "../src/tools/executor.ts";
import * as Tool from "../src/tools/tool.ts";
import { pendingCall } from "./tools.fixture.ts";

class ExpectedFailure extends Schema.TaggedError<ExpectedFailure>()("ExpectedFailure", {
	message: Schema.String,
}) {}

const EmptyParams = Schema.Struct({});
const EmptySuccess = Schema.Struct({});

const call = (name: string) => pendingCall(name, {}, "call-1");

describe("Tool definition", () => {
	it("is pure, serializable data", () => {
		expect(bashDef.name).toBe("bash");
		expect(bashDef.label).toBe("bash");
		expect(bashDef.failureMode).toBe("return");
		expect(typeof bashDef.description).toBe("string");
		// schemas are present (not the decoded values)
		expect(bashDef.parameters).toBeDefined();
		expect(bashDef.success).toBeDefined();
		expect(bashDef.failure).toBeDefined();
	});

	it('defaults failureMode to "return"', () => {
		const def = Tool.define({
			name: "noop",
			description: "does nothing",
			parameters: Schema.Struct({}),
			success: Schema.Struct({}),
		});
		expect(def.failureMode).toBe("return");
	});
});

describe("toProviderJsonSchema", () => {
	it("derives a provider-clean JSON schema with no top-level $ref", () => {
		const js = Tool.toProviderJsonSchema(bashDef.parameters);

		expect(js.type).toBe("object");
		expect(js).not.toHaveProperty("$ref");
		expect(js.properties).toBeDefined();

		const properties = js.properties as Record<string, unknown>;
		expect(properties.command).toBeDefined();
		expect(properties.timeout).toBeDefined();

		// `command` is required; `timeout` is optional.
		expect(js.required).toContain("command");
		expect(js.required).not.toContain("timeout");
	});

	it("inlines nested struct references (no top-level $ref) for a non-trivial schema", () => {
		const Nested = Schema.Struct({
			outer: Schema.Struct({ inner: Schema.String }),
			tags: Schema.optional(Schema.Array(Schema.String)),
		});
		const js = Tool.toProviderJsonSchema(Nested);

		expect(js.type).toBe("object");
		expect(js).not.toHaveProperty("$ref");
		const properties = js.properties as Record<string, { type?: string }>;
		expect(properties.outer?.type).toBe("object");
	});
});

describe("toAikitTool", () => {
	it("produces the aikit wire view (name, description, parameters)", () => {
		const tool = Tool.toAikitTool(bashDef);

		expect(tool.name).toBe("bash");
		expect(typeof tool.description).toBe("string");
		expect(tool.parameters).toBeDefined();
		// parameters is the derived JSON schema object
		expect((tool.parameters as unknown as { type?: string }).type).toBe("object");
	});
});

describe("Executor", () => {
	it("fails fast when two tools register the same name", () => {
		const first = Tool.make({
			name: "duplicate",
			description: "first tool",
			parameters: EmptyParams,
			success: EmptySuccess,
			handler: () => Effect.succeed({}),
		});
		const second = Tool.make({
			name: "duplicate",
			description: "second tool",
			parameters: EmptyParams,
			success: EmptySuccess,
			handler: () => Effect.succeed({}),
		});

		expect(() => Executor.make([Tool.register(first), Tool.register(second)])).toThrow(/duplicate/i);
	});

	it('propagates declared failures when failureMode is "error"', async () => {
		const tool = Tool.make({
			name: "expectedFailure",
			description: "fails through the error channel",
			parameters: EmptyParams,
			success: EmptySuccess,
			failure: ExpectedFailure,
			failureMode: "error",
			handler: () => Effect.fail(new ExpectedFailure({ message: "boom" })),
		});
		const executor = Executor.make([Tool.register(tool)]);

		const exit = await Effect.runPromiseExit(executor.handle(call("expectedFailure")));

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const failure = Cause.findErrorOption(exit.cause);
			expect(Option.isSome(failure)).toBe(true);
			if (Option.isSome(failure)) {
				expect(failure.value).toBeInstanceOf(ToolExecutionError);
				expect(failure.value.toolName).toBe("expectedFailure");
				expect(failure.value.cause).toBeInstanceOf(ExpectedFailure);
			}
		}
	});

	it('returns declared failures as tool errors when failureMode is "return"', async () => {
		const tool = Tool.make({
			name: "returnedFailure",
			description: "fails as a tool result",
			parameters: EmptyParams,
			success: EmptySuccess,
			failure: ExpectedFailure,
			failureMode: "return",
			handler: () => Effect.fail(new ExpectedFailure({ message: "boom" })),
		});
		const executor = Executor.make([Tool.register(tool)]);

		const outcome = await Effect.runPromise(executor.handle(call("returnedFailure")));

		expect(outcome.status).toBe("error");
		expect(outcome.result.isError).toBe(true);
		expect(outcome.result.details).toMatchObject({ _tag: "ExpectedFailure", message: "boom" });
	});

	it("preserves the complete pending part when producing a terminal result", async () => {
		const tool = Tool.make({
			name: "metadata",
			description: "returns successfully",
			parameters: EmptyParams,
			success: EmptySuccess,
			handler: () => Effect.succeed({}),
		});
		const executor = Executor.make([Tool.register(tool)]);
		const pending = {
			...pendingCall("metadata", {}, "provider-call-1"),
			thoughtSignature: "opaque-provider-signature",
			time: { start: 100, end: 120 },
		};

		const outcome = await Effect.runPromise(executor.handle(pending));

		expect(outcome).toMatchObject({
			type: "toolCall",
			callID: "provider-call-1",
			name: "metadata",
			arguments: {},
			thoughtSignature: "opaque-provider-signature",
			status: "completed",
			time: { start: 100 },
		});
		expect(outcome.time.end).toBeGreaterThanOrEqual(120);
	});

	it("omits optional details from content-only results", async () => {
		const tool = Tool.make({
			name: "contentOnly",
			description: "returns content without structured details",
			parameters: EmptyParams,
			success: Schema.Void,
			encodeContent: () => [{ type: "text", text: "done" }],
			handler: () => Effect.void,
		});
		const executor = Executor.make([Tool.register(tool)]);

		const outcome = await Effect.runPromise(executor.handle(call("contentOnly")));

		expect(outcome.status).toBe("completed");
		expect(outcome.result.content).toEqual([{ type: "text", text: "done" }]);
		expect(outcome.result).not.toHaveProperty("details");
	});
});
