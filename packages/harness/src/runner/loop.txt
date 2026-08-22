/*
 * @file Effect-native durable session loop.
 *
 * The loop owns delivery and execution order. It promotes durable input, asks
 * Context for the current storage-faithful aikit messages, and sends the aikit
 * provider events through their request-scoped publisher. It never reads or
 * writes Session.Service directly.
 */

import type { Message } from "@codeworksh/aikit";
import { Effect, Layer } from "effect";
import { Context } from "../context/context.ts";
import { Event } from "../event/event.ts";
import { SessionInput } from "../session/input/input.ts";
import type { SessionSchema } from "../session/schema.ts";
import { LLMEventPublisher } from "./event.ts";
import { LLM } from "./llm.ts";
import { Runner } from "./run.ts";

export interface Options {
	readonly provider?: string;
	readonly model?: string;
	readonly systemPrompt?: string;
	/** Deterministic test seam; production resolves and streams through aikit. */
	readonly request?: LLM.Request;
}

const defaults = {
	provider: "openai",
	model: "gpt-5.5",
	systemPrompt: "You are a concise coding assistant.",
} as const;

export const layer = (options: Options = {}) =>
	Layer.effect(
		Runner.Service,
		Effect.gen(function* () {
			const context = yield* Context.Service;
			const events = yield* Event.Service;
			const inputs = yield* SessionInput.make;
			const provider = options.provider ?? defaults.provider;
			const model = options.model ?? defaults.model;
			const requestLLM = options.request ?? LLM.run;

			const runTurn = Effect.fn("Loop.runTurn")(function* (
				sessionId: SessionSchema.ID,
				promotion: "steer" | "followUp" | undefined,
			) {
				let promoted = 0;
				if (promotion !== undefined) {
					// Capture outside the promotion commit: inputs admitted after this
					// position belong to the next provider request.
					const cutoff = yield* events.latestSequence(sessionId);
					if (promotion === "followUp") promoted += Number(yield* inputs.promoteFollowUp(sessionId));
					promoted += yield* inputs.promoteSteers(sessionId, cutoff);
					if (promoted === 0) return { ran: false, promoted: 0 } as const;
				}

				// This is our toLLMMessages boundary: Context reads native durable
				// history and returns aikit's canonical Message.Context values.
				const snapshot = yield* context.assemble(sessionId);
				const requestContext: Message.Context = {
					systemPrompt: options.systemPrompt ?? defaults.systemPrompt,
					messages: [...snapshot.messages],
				};
				const label = promotion ?? "forced";
				yield* Effect.logInfo("loop: delivering").pipe(Effect.annotateLogs({ sessionId, lane: label, promoted }));

				const publisher = yield* LLMEventPublisher.make({ sessionId }).pipe(
					Effect.provideService(Event.Service, events),
				);
				const terminal = yield* requestLLM({
					sessionId,
					context: requestContext,
					provider,
					model,
					publisher,
				});
				yield* Effect.logInfo("loop: aikit response settled").pipe(
					Effect.annotateLogs({
						sessionId,
						messageId: terminal.message.messageId,
						outcome: terminal.outcome,
						reason: terminal.reason,
					}),
				);
				if (terminal.outcome === "failed") {
					return yield* new Runner.ProviderTurnError({
						provider,
						model,
						cause: new Error(terminal.message.errorMessage ?? `Provider turn ${terminal.reason}`),
					});
				}
				return { ran: true, promoted } as const;
			});

			const run = Effect.fn("Loop.run")(function* (input: {
				readonly sessionId: SessionSchema.ID;
				readonly force: boolean;
			}) {
				yield* Effect.logInfo("loop: run start").pipe(
					Effect.annotateLogs({
						sessionId: input.sessionId,
						force: input.force,
					}),
				);

				const hasSteer = yield* inputs.hasPending(input.sessionId, "steer");
				const hasFollowUp = hasSteer ? false : yield* inputs.hasPending(input.sessionId, "followUp");
				if (!input.force && !hasSteer && !hasFollowUp) {
					yield* Effect.logInfo("loop: nothing eligible, idling").pipe(
						Effect.annotateLogs({ sessionId: input.sessionId }),
					);
					return;
				}

				let promotion: "steer" | "followUp" | undefined = hasSteer ? "steer" : hasFollowUp ? "followUp" : undefined;
				let shouldRun = input.force || hasSteer || hasFollowUp;
				let delivered = 0;
				while (shouldRun) {
					let needsContinuation = true;
					while (needsContinuation) {
						const turn = yield* runTurn(input.sessionId, promotion);
						delivered += turn.promoted;
						promotion = "steer";
						needsContinuation = turn.ran && (yield* inputs.hasPending(input.sessionId, "steer"));
					}
					shouldRun = yield* inputs.hasPending(input.sessionId, "followUp");
					promotion = shouldRun ? "followUp" : undefined;
				}

				yield* Effect.logInfo("loop: run end").pipe(Effect.annotateLogs({ sessionId: input.sessionId, delivered }));
			});

			return Runner.Service.of({ run });
		}),
	);

export * as Loop from "./loop.ts";
