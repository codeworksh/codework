import type { Message } from "@codeworksh/aikit";
import { Effect, Schema } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { builtins } from "../src/plugin/builtin.ts";
import { TOOL_SEARCH_NAME, toolSearchPlugin } from "../src/plugin/builtin/tool/toolsearch.ts";
import { define } from "../src/plugin/plugin.ts";
import { LLM } from "../src/runner/llm.ts";
import * as Tool from "../src/tool/tool.ts";
import { withSettings } from "./fixtures/settings.ts";
import { available, LIVE } from "./utils/live.ts";

/**
 * One run against a real model: the token is held by a deferred tool the model is not offered,
 * so a right reply means it searched, the load reached its next request, and it called the tool.
 * On Anthropic the deferred catalog is declared up front and the load names the tool by reference,
 * so the request after the load reads the one before it from the cache.
 */

const TOKEN = "vq7-lumen-4821";
process.env.CODEWORK_CACHE_RETENTION ??= "short";
const CASES = [
	{ live: LIVE.find((one) => one.name === "openai-codex")!, model: "gpt-6-luna", cache: false },
	{ live: LIVE.find((one) => one.name === "anthropic")!, model: "claude-sonnet-5-5", cache: true },
];

/** A request as sent: its declared tools, and the tools its system messages add. */
type Sent = { readonly tools: ReadonlyArray<string>; readonly system: ReadonlyArray<ReadonlyArray<string>> };
const sentOf = (context: Message.Context): Sent => ({
	tools: (context.tools ?? []).map((tool) => tool.name),
	system: context.messages.flatMap((message) =>
		message.role === "system" ? [(message.toolsAdded ?? []).map((tool) => tool.name)] : [],
	),
});

describe.each(CASES)("toolsearch against live $live.name", ({ live, model, cache }) => {
	it.skipIf(!available(live))("finds a deferred tool, then calls it", { timeout: 300_000 }, () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(
				join(custom, "settings.jsonc"),
				JSON.stringify({ model: { provider: live.provider, id: model } }),
			);
			const vault = define({
				id: "acme.tool.vault",
				kind: "tool",
				setup(ctx) {
					ctx.plugin.tools.add(
						Tool.register(
							Tool.make({
								name: "vault_read_token",
								description: "Read the deployment access token stored in the secrets vault.",
								exposure: "deferred",
								parameters: Schema.Struct({}),
								success: Schema.String,
								encodeContent: (value: string) => [{ type: "text", text: value }],
								handler: () => Effect.succeed(TOKEN),
							}),
						),
					);
				},
			});

			const sent: Sent[] = [];
			const llm: LLM.Open = (input, signal) => {
				sent.push(sentOf(input.context));
				return LLM.open(input, signal);
			};

			const { calls, reply, cacheReads } = await Effect.gen(function* () {
				const handle = yield* Session.create({ directory: root });
				yield* handle.main.run(
					"Find the tool that reads the deployment access token from the secrets vault, call it, " +
						"and reply with exactly the token it returns and nothing else.",
				);
				const messages = yield* Effect.forEach(yield* handle.main.history(), ContextCodec.decodeMessage);
				const last = messages.findLast((message) =>
					ContextCodec.parts(message).some((part) => part.type === "text"),
				);
				return {
					calls: messages
						.flatMap((message) => ContextCodec.parts(message))
						.flatMap((part) => (part.type === "toolCall" ? [`${part.name}:${part.status}`] : [])),
					reply: (last === undefined ? [] : ContextCodec.parts(last))
						.flatMap((part) => (part.type === "text" ? [part.text] : []))
						.join(""),
					// One assistant message per request, in order.
					cacheReads: messages.flatMap((message) =>
						message.role === "assistant" ? [message.usage.cacheRead] : [],
					),
				};
			}).pipe(
				Effect.provide(
					Harness.layer({
						home: join(root, "home"),
						hostCwd: root,
						database: ":memory:",
						userConfigDir: custom,
						// toolsearch ships off (`optIn`); this entry turns it on.
						plugins: [...builtins, vault, { plugin: toolSearchPlugin.id, enabled: true }],
						llm,
					}),
				),
				Effect.scoped,
				Effect.timeout("240 seconds"),
				Effect.runPromise,
			);

			const found = reply.includes(TOKEN);
			// The request that called the vault tool is the first one whose system messages add it.
			const loadedAt = sent.findIndex((one) => one.system.some((added) => added.includes("vault_read_token")));
			expect(calls).toContain(`${TOOL_SEARCH_NAME}:completed`);
			expect(calls).toContain("vault_read_token:completed");
			expect(loadedAt).toBeGreaterThan(0);
			expect(sent.every((one) => !one.tools.includes("vault_read_token"))).toBe(true);
			expect(found).toBe(true);
			const cachedAfterLoad = (cacheReads[loadedAt] ?? 0) > 0;
			if (cache) expect(cachedAfterLoad).toBe(true);

			await expect(
				`${JSON.stringify({ requests: sent, calls, found, ...(cache ? { cachedAfterLoad } : {}) }, null, "\t")}\n`,
			).toMatchFileSnapshot(`./__artifacts__/tools.toolsearch.live.${live.name}.json`);
		}),
	);
});
