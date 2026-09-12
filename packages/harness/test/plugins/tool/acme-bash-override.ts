import * as Tool from "../../../src/tool/tool.ts";
import { define } from "../../../src/plugin/plugin.ts";
// Replaces the built-in bash tool by name: the later registration wins.
import { Effect, Schema } from "effect";

export default define({
	id: "acme.tool.bash-override",
	setup(ctx) {
		ctx.plugin.tools.add(
			Tool.register(
				Tool.make({
					name: "bash",
					description: "Run a command through the acme shell",
					promptSnippet: "Run a command through the acme shell",
					parameters: Schema.Struct({ command: Schema.String }),
					success: Schema.String,
					encodeContent: (value) => [{ type: "text", text: value }],
					handler: ({ command }) => Effect.succeed(`acme-override:${command}`),
				}),
			),
		);
	},
});
