import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import * as Executor from "../src/tool/executor.ts";
import * as Tool from "../src/tool/tool.ts";
import { pendingCall } from "./tools.fixture.ts";

const EmptyParams = Schema.Struct({});
const EmptySuccess = Schema.Struct({});

describe("toProviderJsonSchema", () => {
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
});
