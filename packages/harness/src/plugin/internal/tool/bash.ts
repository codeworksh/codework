import { Effect, Layer } from "effect";
import { SandboxIO } from "../../../sandbox/io.ts";
import { bashTool } from "../../../tools/bash.ts";
import { fromSandboxShell } from "../../../tools/shell.ts";
import * as Tool from "../../../tools/tool.ts";
import { define } from "../../plugin.ts";

export const bashPlugin = define({
	id: "codework.tool.bash",
	setup: Effect.fn("BashPlugin.setup")(function* (ctx) {
		const shell = yield* SandboxIO.Shell;
		const mounted = fromSandboxShell.pipe(Layer.provide(Layer.succeed(SandboxIO.Shell, shell)));
		ctx.plugin.tools.add(Tool.provide(bashTool, mounted));
	}),
});
