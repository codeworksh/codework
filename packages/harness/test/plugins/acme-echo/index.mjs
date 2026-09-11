// A third-party tool plugin written in plain JS: no TypeScript, no harness import.
// The contract it codes against is structural — a `{ id, setup }` default export.
import { Effect, Schema } from "effect";

export default {
	id: "acme.tool.echo",
	setup(ctx) {
		ctx.plugin.tools.add(
			{
				definition: {
					name: "acme_echo",
					description: "Echo a value back",
					promptSnippet: "Echo a value back",
					parameters: Schema.Struct({ value: Schema.String }),
					success: Schema.String,
					encodeContent: (value) => [{ type: "text", text: value }],
				},
				handler: ({ value }) => Effect.succeed(value),
			},
			{
				afterToolCall: ({ terminal }) =>
					terminal.status === "completed"
						? { content: [...terminal.result.content, { type: "text", text: "(acme-checked)" }] }
						: undefined,
			},
		);
	},
};
