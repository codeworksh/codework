import { Effect, Schema } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { define } from "../src/plugin/plugin.ts";
import { SessionRuntime } from "../src/session/runtime.ts";
import type { State } from "../src/state/state.ts";
import * as Tool from "../src/tool/tool.ts";
import { withSettings } from "./fixtures/settings.ts";
import { available, LIVE } from "./utils/live.ts";

/**
 * One run, one tool chain, against a real provider. The first tool's handler edits the host
 * settings file and unlocks a second tool; both land on the very next request of the same chain,
 * because every turn takes a fresh snapshot. The second tool's token is only reachable through
 * that tool, so a right reply means the mid-chain declaration was really callable.
 */

const FIRST = "alpha-91";
const SECOND = "omega-27";

/** The request as sent, reduced to what a mid-chain change can move. */
type Sent = { readonly revision?: unknown; readonly tools: ReadonlyArray<string> };

describe.each(LIVE)("turn snapshots against live $name", (live) => {
	it.skipIf(!available(live))(
		"lands a settings edit and a tool declared during a tool batch on the next request",
		{ timeout: 300_000 },
		() =>
			withSettings(async ({ root, custom }) => {
				const write = (revision: string) =>
					writeFile(
						join(custom, "settings.jsonc"),
						JSON.stringify({
							model: {
								provider: live.provider,
								id: live.id,
								providerOptions: {
									[live.provider]: { [live.id]: { headers: { "x-settings-revision": revision } } },
								},
							},
						}),
					);
				let unlocked = false;
				const first = Tool.register(
					Tool.make({
						name: "first",
						description: "Returns the first token and names the next step. Takes no arguments.",
						parameters: Schema.Struct({}),
						success: Schema.String,
						encodeContent: (value) => [{ type: "text", text: value }],
						handler: () =>
							Effect.gen(function* () {
								yield* Effect.promise(() => write("b"));
								unlocked = true;
								return `${FIRST}. Now call the tool named second.`;
							}),
					}),
				);
				const second = Tool.register(
					Tool.make({
						name: "second",
						description: "Returns the second token. Takes no arguments.",
						parameters: Schema.Struct({}),
						success: Schema.String,
						encodeContent: (value) => [{ type: "text", text: value }],
						handler: () => Effect.succeed(SECOND),
					}),
				);
				const relay = define({
					id: "acme.tool.relay",
					kind: "tool",
					setup(ctx) {
						ctx.plugin.tools.add(first);
						if (unlocked) ctx.plugin.tools.add(second);
					},
				});

				const sent: Sent[] = [];
				const onPayload: NonNullable<State.RequestOptions["onPayload"]> = async (payload) => {
					const params = payload as Record<string, unknown>;
					sent.push({
						revision: (params.headers as Record<string, unknown> | undefined)?.["x-settings-revision"],
						tools: Object.keys((params.tools as Record<string, unknown> | undefined) ?? {}).filter(
							(name) => name === "first" || name === "second",
						),
					});
					return payload;
				};

				await write("a");
				const { calls, reply } = await Effect.gen(function* () {
					const handle = yield* Session.create({ directory: root });
					const runtime = yield* SessionRuntime.Service;
					yield* runtime.update(handle.id, { onPayload });
					yield* handle.run(
						"Call the first tool and follow its instruction. Then reply with exactly the two tokens " +
							"the tools returned, separated by one space, and nothing else.",
					);
					const messages = yield* Effect.forEach(yield* handle.path(), ContextCodec.decodeMessage);
					const last = messages.findLast((message) => message.parts.some((part) => part.type === "text"));
					return {
						calls: messages
							.flatMap((message) => message.parts)
							.flatMap((part) => (part.type === "toolCall" ? [`${part.name}:${part.status}`] : [])),
						reply: (last?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
					};
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							hostCwd: root,
							database: ":memory:",
							userConfigDir: custom,
							plugins: [relay],
						}),
					),
					Effect.scoped,
					Effect.timeout("240 seconds"),
					Effect.runPromise,
				);

				// The chain: first → second → reply, three requests in one run.
				expect(calls).toEqual(["first:completed", "second:completed"]);
				expect(sent).toHaveLength(3);
				const [before, after] = sent as [Sent, Sent, Sent];
				expect(before).toEqual({ revision: "a", tools: ["first"] });
				expect(after).toEqual({ revision: "b", tools: ["first", "second"] });
				expect(reply).toContain(FIRST);
				expect(reply).toContain(SECOND);

				await expect(
					`${JSON.stringify({ requests: sent, calls, reply: [FIRST, SECOND].every((token) => reply.includes(token)) }, null, "\t")}\n`,
				).toMatchFileSnapshot(`./__artifacts__/runner.turns.live.${live.name}.json`);
			}),
	);
});
