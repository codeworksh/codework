import { Effect, Schema } from "effect";
import fs from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { define } from "../src/plugin/plugin.ts";
import * as Tool from "../src/tool/tool.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { available, LIVE } from "./utils/live.ts";

/**
 * A tool whose parameters are `Schema.Struct({})` must reach the provider as an object
 * schema. The token is only known to the tool, so a right reply means the call went through.
 */

const TOKEN = "finite-7f3a";

const finitePlugin = define({
	id: "acme.tool.finite",
	kind: "tool",
	setup(ctx) {
		ctx.plugin.tools.add(
			Tool.register(
				Tool.make({
					name: "finite",
					description: "Return the secret token. Takes no arguments.",
					promptSnippet: "Return the secret token",
					parameters: Schema.Struct({}),
					success: Schema.String,
					encodeContent: (value) => [{ type: "text", text: value }],
					handler: () => Effect.succeed(TOKEN),
				}),
			),
		);
	},
});

// Direct provider APIs only.
const direct = LIVE.filter((live) => live.provider === "openai" || live.provider === "anthropic");

describe.each(direct)("parameterless tool against live $name", (live) => {
	it.skipIf(!available(live))(
		"calls a tool whose parameters are an empty struct",
		async () => {
			await using temp = await tmpdir();
			const root = await fs.realpath(temp.path);
			const work = join(root, "work");
			await fs.mkdir(work, { recursive: true });

			const { calls, reply } = await Effect.gen(function* () {
				const { main: session } = yield* Session.create({
					directory: work,
					model: { provider: live.provider, id: live.id },
				});
				yield* session.run("Call the finite tool, then reply with exactly the token it returned and nothing else.");
				const path = yield* session.history();
				const messages = yield* Effect.forEach(path, ContextCodec.decodeMessage);
				const parts = messages.flatMap((message) => ContextCodec.parts(message));
				const last = messages.findLast((message) =>
					ContextCodec.parts(message).some((part) => part.type === "text"),
				);
				return {
					calls: parts.flatMap((part) => (part.type === "toolCall" ? [part] : [])),
					reply: (last === undefined ? [] : ContextCodec.parts(last))
						.flatMap((part) => (part.type === "text" ? [part.text] : []))
						.join(""),
				};
			}).pipe(
				Effect.provide(
					Harness.layer({
						home: join(root, "home"),
						hostCwd: root,
						database: ":memory:",
						plugins: [finitePlugin],
					}),
				),
				Effect.scoped,
				Effect.timeout("120 seconds"),
				Effect.runPromise,
			);

			const finite = calls.filter((call) => call.name === "finite").map((call) => call.status);
			expect(finite).toContain("completed");
			const result = { finite: "completed", reply: reply.trim().replace(/^`|`$/g, "") };
			expect(result.reply).toBe(TOKEN);

			await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot(
				`./__artifacts__/tools.empty.live.${live.name}.json`,
			);
		},
		180_000,
	);
});
