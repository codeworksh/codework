import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { bashDef } from "../src/plugin/internal/tool/bash.ts";
import * as Executor from "../src/tool/executor.ts";
import * as Tool from "../src/tool/tool.ts";
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
		expect(typeof bashDef.description).toBe("string");
		// schemas are present (not the decoded values)
		expect(bashDef.parameters).toBeDefined();
		expect(bashDef.success).toBeDefined();
		expect(bashDef.failure).toBeDefined();
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

	it("returns declared failures as encoded tool errors", async () => {
		const tool = Tool.make({
			name: "returnedFailure",
			description: "fails as a tool result",
			parameters: EmptyParams,
			success: EmptySuccess,
			failure: ExpectedFailure,
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
