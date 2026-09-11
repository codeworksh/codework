// A policy-style plugin: its own tool gated by a beforeToolCall block verdict.
import { Effect, Schema } from "effect";

export default {
	id: "acme.tool.guarded",
	setup(ctx) {
		ctx.plugin.tools.add(
			{
				definition: {
					name: "acme_secret",
					description: "Read a secret",
					parameters: Schema.Struct({ value: Schema.String }),
					success: Schema.String,
					encodeContent: (value) => [{ type: "text", text: value }],
				},
				handler: ({ value }) => Effect.succeed(`classified:${value}`),
			},
			{
				beforeToolCall: ({ params }) =>
					params.value === "deny" ? { block: true, reason: "denied by acme policy" } : undefined,
			},
		);
	},
};
