import { llm } from "@codeworksh/aikit";
import { Effect } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { SessionRuntime } from "../src/session/runtime.ts";
import type { State } from "../src/state/state.ts";
import { withSettings } from "./fixtures/settings.ts";
import "./utils/env.ts";

const live = process.env.OPENAI_API_KEY ? it : it.skip;

/** The request the AI SDK is about to send, reduced to what settings are meant to drive. */
type Sent = {
	readonly provider: string;
	readonly model: string;
	readonly reasoningEffort?: unknown;
	readonly reasoningSummary?: unknown;
	readonly maxOutputTokens?: unknown;
	readonly headers?: unknown;
};

describe("settings against a live provider", () => {
	/*
	 * A real OpenAI turn per edit. `onPayload` is aikit's own hook for the final request
	 * params, so this asserts on what the provider is actually sent rather than on
	 * anything the harness reports about itself.
	 */
	live("applies edited settings to each real turn, including a revert", { timeout: 300_000 }, () =>
		withSettings(async ({ root, custom }) => {
			const write = (model: object) => writeFile(join(custom, "settings.json"), JSON.stringify({ model }));
			// A names a budget, a summary mode and a header. B names none of them.
			const selection = { provider: "openai", id: "gpt-5.6-luna" };
			const catalog = await llm(selection.provider, selection.id);
			expect(catalog).toBeDefined();
			const A = {
				...selection,
				thinkingLevel: "low",
				providerOptions: {
					openai: {
						"gpt-5.6-luna": {
							thinkingLevel: "low",
							thinkingBudgets: { low: 1024 },
							maxTokens: 2048,
							reasoningSummary: "auto",
							headers: { "x-settings-revision": "a" },
						},
					},
				},
			};
			const B = { ...selection, thinkingLevel: "low" };

			const sent: Sent[] = [];
			const replies: string[] = [];
			const onPayload: NonNullable<State.RequestOptions["onPayload"]> = async (payload, model) => {
				const params = payload as Record<string, unknown>;
				const openai = ((params.providerOptions ?? {}) as Record<string, Record<string, unknown>>).openai ?? {};
				sent.push({
					provider: model.provider.id,
					model: model.id,
					reasoningEffort: openai.reasoningEffort,
					reasoningSummary: openai.reasoningSummary,
					maxOutputTokens: params.maxOutputTokens,
					headers: params.headers,
				});
				return payload;
			};

			await write(A);
			await Effect.runPromise(
				Effect.gen(function* () {
					const handle = yield* Session.create({
						directory: root,
						// Selection and matching controls come from the host file.
						tools: { builtins: [] },
					});
					const runtime = yield* SessionRuntime.Service;
					yield* runtime.update(handle.id, { onPayload });
					yield* handle.run("Reply with the single word: one");
					yield* Effect.promise(() => write(B));
					yield* handle.run("Reply with the single word: two");
					yield* Effect.promise(() => write(A));
					yield* handle.run("Reply with the single word: three");
					for (const hydrated of yield* handle.path()) {
						if (hydrated.entry.type !== "assistant") continue;
						expect(hydrated.entry.state).toBe("committed");
						replies.push(
							hydrated.parts
								.filter((part) => part.type === "text")
								.map((part) => (JSON.parse(part.data) as { readonly text?: string }).text ?? "")
								.join(""),
						);
					}
				}).pipe(
					Effect.provide(Harness.layer({ home: join(root, "home"), database: ":memory:", userConfigDir: custom })),
					Effect.scoped,
					Effect.timeout("240 seconds"),
				),
			);

			// The payload hook fires before the request, so it alone cannot prove a turn
			// succeeded. Every prompt must have a committed assistant answer with text.
			const answered = replies.filter((reply) => reply.trim().length > 0);
			expect(answered).toHaveLength(3);

			expect(sent).toHaveLength(3);
			for (const request of sent)
				expect(request).toMatchObject({ provider: selection.provider, model: selection.id });
			const [first, second, third] = sent as [Sent, Sent, Sent];

			expect(first.reasoningEffort).toBe("low");
			expect(first.reasoningSummary).toBe("auto");
			expect(first.headers).toMatchObject({ "x-settings-revision": "a" });
			// aikit includes the explicit thinking budget in the provider token cap.
			expect(first.maxOutputTokens).toBe(3072);

			// B carries none of A's attributes, so each one falls back rather than persisting.
			expect(second.reasoningEffort).toBe("low");
			expect(second.reasoningSummary).toBeUndefined();
			expect(second.headers).toBeUndefined();
			expect(second.maxOutputTokens).toBe(catalog?.maxTokens);

			// Reverting restores every one of them.
			expect(third.reasoningEffort).toBe("low");
			expect(third.reasoningSummary).toBe("auto");
			expect(third.headers).toMatchObject({ "x-settings-revision": "a" });
			expect(third.maxOutputTokens).toBe(first.maxOutputTokens);
		}),
	);
});
