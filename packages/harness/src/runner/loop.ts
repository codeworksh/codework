/*
 * @file Effect-native durable session loop.
 *
 * The loop owns delivery and execution order. It promotes durable input, asks
 * Context for the current storage-faithful aikit messages, exercises the
 * mounted sandbox, calls aikit, and logs the complete response. It never reads
 * or writes Session.Service directly.
 */

import { llm, type Message, stream } from "@codeworksh/aikit";
import { Effect, Layer } from "effect";
import { HarnessContext } from "../context/context.ts";
import { Event } from "../event/event.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { quote } from "../sandbox/shell/shell.ts";
import { SessionInput } from "../session/input/input.ts";
import type { SessionSchema } from "../session/schema.ts";
import { Runner } from "./run.ts";

export interface CompletionInput {
	readonly sessionId: SessionSchema.ID;
	readonly context: Message.Context;
	readonly provider: string;
	readonly model: string;
}

export type Completion = (
	input: CompletionInput,
) => Effect.Effect<Message.AssistantMessage, Runner.ModelNotFoundError | Runner.ProviderTurnError>;

export interface Options {
	readonly provider?: string;
	readonly model?: string;
	readonly systemPrompt?: string;
	/** Test/application seam; the default resolves and calls aikit directly. */
	readonly complete?: Completion;
	/** Seconds between sandbox verification output lines. */
	readonly intervalSeconds?: number;
	/** Fewest lines emitted by one sandbox verification turn. */
	readonly minLines?: number;
	/** Most lines emitted by one sandbox verification turn. */
	readonly maxLines?: number;
}

const defaults = {
	provider: "openai",
	model: "gpt-4o-mini",
	systemPrompt: "You are a concise coding assistant.",
	intervalSeconds: 1,
	minLines: 2,
	maxLines: 7,
} as const;

/** Deterministic size of one sandbox verification turn. */
export const linesFor = (position: number, options: Options = {}): number => {
	const min = options.minLines ?? defaults.minLines;
	const max = options.maxLines ?? defaults.maxLines;
	const span = Math.max(1, max - min + 1);
	return min + (Math.abs(position) % span);
};

const latestUserText = (messages: ReadonlyArray<Message.Message>): string => {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		const text = message.parts.find((part) => part.type === "text");
		return text?.type === "text" ? text.text : message.messageId;
	}
	return "forced turn, no queued input";
};

const echoText = (text: string): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= 60 ? flat : `${flat.slice(0, 57)}...`;
};

/** Portable shell work shared by every supported sandbox backend. */
export const script = (text: string, lines: number, intervalSeconds: number): string =>
	`for i in $(seq 1 ${lines}); do echo ${quote(text)} "$i"; sleep ${intervalSeconds}; done`;

const liveCompletion = (provider: string, modelId: string): Completion =>
	Effect.fn("Loop.complete")(function* (input) {
		const model = yield* Effect.tryPromise({
			try: () => llm(provider, modelId),
			catch: (cause) => new Runner.ProviderTurnError({ provider, model: modelId, cause }),
		});
		if (model === undefined) return yield* new Runner.ModelNotFoundError({ provider, model: modelId });
		return yield* Effect.tryPromise({
			try: () => stream.complete(model, input.context),
			catch: (cause) => new Runner.ProviderTurnError({ provider, model: modelId, cause }),
		});
	});

export const layer = (options: Options = {}) =>
	Layer.effect(
		Runner.Service,
		Effect.gen(function* () {
			const context = yield* HarnessContext.Service;
			const events = yield* Event.Service;
			const inputs = yield* SessionInput.make;
			const provider = options.provider ?? defaults.provider;
			const model = options.model ?? defaults.model;
			const complete = options.complete ?? liveCompletion(provider, model);
			const intervalSeconds = options.intervalSeconds ?? defaults.intervalSeconds;

			// Resolve both mounted capabilities on every run. This keeps the loop an
			// end-to-end check that RunnerExecute supplied the selected sandbox rather
			// than accidentally falling back to host process state.
			const probe = Effect.fnUntraced(function* () {
				const shell = yield* SandboxIO.Shell;
				const fs = yield* SandboxIO.FileSystem;
				const pwd = yield* shell.exec("pwd").pipe(
					Effect.map((result) => result.stdout.trim()),
					Effect.orElseSucceed(() => "<shell unavailable>"),
				);
				const reachable = yield* fs.exists(pwd).pipe(Effect.orElseSucceed(() => false));
				return { pwd, reachable };
			});

			// This is retained alongside the provider call deliberately. It exercises
			// shell execution, cwd routing, quoting, output capture, and cancellation
			// through the exact sandbox mount owned by this session run.
			const sandboxTurn = Effect.fnUntraced(function* (label: string, text: string, lines: number) {
				const shell = yield* SandboxIO.Shell;
				yield* Effect.logInfo("loop: sandbox turn start").pipe(
					Effect.annotateLogs({ label, lines, intervalSeconds }),
				);
				const result = yield* shell
					.exec(script(text, lines, intervalSeconds))
					.pipe(Effect.mapError((cause) => new Runner.ShellWorkError({ command: cause.command, cause })));
				const emitted = result.stdout.split("\n").filter((line) => line.length > 0).length;
				yield* Effect.logInfo("loop: sandbox turn end").pipe(
					Effect.annotateLogs({ label, exitCode: result.exitCode, emitted }),
				);
				return emitted;
			});

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
					if (promoted === 0) return { ran: false, promoted: 0, emitted: 0 } as const;
				}

				// This is our toLLMMessages boundary: Context reads native durable
				// history and returns aikit's canonical Message.Context values.
				const snapshot = yield* context.assemble(sessionId);
				const request: Message.Context = {
					systemPrompt: options.systemPrompt ?? defaults.systemPrompt,
					messages: [...snapshot.messages],
				};
				const label = promotion ?? "forced";
				const position = request.messages.filter((message) => message.role === "user").length;
				const lines = linesFor(position, options);
				yield* Effect.logInfo("loop: delivering").pipe(
					Effect.annotateLogs({ sessionId, lane: label, promoted }),
				);
				const emitted = yield* sandboxTurn(label, echoText(latestUserText(request.messages)), lines);

				// aikit is an additional boundary after the sandbox-backed turn work; it
				// does not replace the execution-environment verification above.
				const response = yield* complete({ sessionId, context: request, provider, model });
				yield* Effect.logInfo("loop: aikit response").pipe(
					Effect.annotateLogs({
						sessionId,
						messageId: response.messageId,
						stopReason: response.stopReason,
						parts: response.parts,
					}),
				);
				return { ran: true, promoted, emitted } as const;
			});

			const run = Effect.fn("Loop.run")(function* (input: {
				readonly sessionId: SessionSchema.ID;
				readonly force: boolean;
			}) {
				const where = yield* probe();
				yield* Effect.logInfo("loop: run start").pipe(
					Effect.annotateLogs({
						sessionId: input.sessionId,
						pwd: where.pwd,
						pwdExists: where.reachable,
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
				let emitted = 0;
				while (shouldRun) {
					let needsContinuation = true;
					while (needsContinuation) {
						const turn = yield* runTurn(input.sessionId, promotion);
						delivered += turn.promoted;
						emitted += turn.emitted;
						promotion = "steer";
						needsContinuation = turn.ran && (yield* inputs.hasPending(input.sessionId, "steer"));
					}
					shouldRun = yield* inputs.hasPending(input.sessionId, "followUp");
					promotion = shouldRun ? "followUp" : undefined;
				}

				yield* Effect.logInfo("loop: run end").pipe(
					Effect.annotateLogs({ sessionId: input.sessionId, delivered, emitted }),
				);
			});

			return Runner.Service.of({ run });
		}),
	);

export * as Loop from "./loop.ts";
