import * as Tool from "../../../../src/tool/tool.ts";
import { define } from "../../../../src/plugin/plugin.ts";
// A typed third-party package fixture loaded through its package export.
import { Effect, Schema } from "effect";

export default define({
	id: "acme.tool.echo",
	setup(ctx) {
		ctx.plugin.tools.add(
			Tool.register(
				Tool.make({
					name: "acme_echo",
					description: "Echo a value back",
					promptSnippet: "Echo a value back",
					parameters: Schema.Struct({ value: Schema.String }),
					success: Schema.String,
					encodeContent: (value) => [{ type: "text", text: value }],
					handler: ({ value }) => Effect.succeed(value),
				}),
			),
			{
				afterToolCall: ({ terminal }) =>
					terminal.status === "completed"
						? { content: [...terminal.result.content, { type: "text", text: "(acme-checked)" }] }
						: undefined,
			},
		);
	},
});
