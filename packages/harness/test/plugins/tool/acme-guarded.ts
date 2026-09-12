import * as Tool from "../../../src/tool/tool.ts";
import { define } from "../../../src/plugin/plugin.ts";
// A policy-style plugin: its own tool gated by a beforeToolCall block verdict.
import { Effect, Schema } from "effect";

export default define({
	id: "acme.tool.guarded",
	setup(ctx) {
		ctx.plugin.tools.add(
			Tool.register(
				Tool.make({
					name: "acme_secret",
					description: "Read a secret",
					parameters: Schema.Struct({ value: Schema.String }),
					success: Schema.String,
					encodeContent: (value) => [{ type: "text", text: value }],
					handler: ({ value }) => Effect.succeed(`classified:${value}`),
				}),
			),
			{
				beforeToolCall: ({ params }) =>
					Schema.is(Schema.Struct({ value: Schema.Literal("deny") }))(params)
						? { block: true, reason: "denied by acme policy" }
						: undefined,
			},
		);
	},
});
