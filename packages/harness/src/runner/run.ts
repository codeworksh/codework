/*
 * @file Defines API for actual run implementation (contract)
 * Typically drain wraps the run to be then drained by the coordinator.
 */

import { Context, Effect, Schema } from "effect";
import type { ContextDecodeError, ContextEncodeError } from "../context/errors.ts";
import type { ID as SessionId } from "../session/schema.ts";
import type { SessionNotFoundError } from "../session/session.ts";

export class ModelNotFoundError extends Schema.TaggedError<ModelNotFoundError>()("Runner.ModelNotFoundError", {
	provider: Schema.String,
	model: Schema.String,
}) {}

export class ProviderTurnError extends Schema.TaggedError<ProviderTurnError>()("Runner.ProviderTurnError", {
	provider: Schema.String,
	model: Schema.String,
	cause: Schema.Defect(),
}) {}

/**
 * The provider stream broke its own protocol: two terminal events, an event
 * after the terminal, a message id that changed mid-response, or a stream that
 * ended without terminating at all.
 *
 * Typed rather than a defect because it is a provider fault, not a broken
 * invariant of ours -- the turn fails, the session stays usable, and the
 * promoted prompt is still there to be answered by the next one.
 */
export class LLMStreamError extends Schema.TaggedError<LLMStreamError>()("Runner.LLMStreamError", {
	sessionId: Schema.String,
	reason: Schema.String,
}) {}

export type RunError =
	| ModelNotFoundError
	| ProviderTurnError
	| LLMStreamError
	| ContextDecodeError
	| ContextEncodeError
	| SessionNotFoundError;

export interface Interface {
	/** Drains eligible durable work. Explicit runs perform one provider attempt even when no work is eligible. */
	readonly run: (input: { readonly sessionId: SessionId; readonly force: boolean }) => Effect.Effect<void, RunError>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/runner/run/Service") {}

export * as Runner from "./run.ts";
