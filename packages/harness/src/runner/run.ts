/*
 * @file Defines API for actual run implementation (contract)
 * Typically drain wraps the run to be then drained by the coordinator.
 */

import { Context, Effect, Schema } from "effect";
import type { ContextDecodeError, ContextEncodeError } from "../context/errors.ts";
import { EventList } from "../event/list.ts";
import { Location } from "../location/location.ts";
import type { SandboxMountError } from "../sandbox/errors.ts";
import { SandboxFileSystem } from "../sandbox/fs/filesystem.ts";
import { SandboxInstance } from "../sandbox/instance.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { optional } from "../schema.ts";
import { SessionMessageSchema } from "../session/message/schema.ts";
import type { ID as SessionId } from "../session/schema.ts";
import type { SessionNotFoundError } from "../session/session.ts";
import type { State } from "../state/state.ts";

export class SandboxDirectoryNotFoundError extends Schema.TaggedError<SandboxDirectoryNotFoundError>()(
	"Runner.SandboxDirectoryNotFoundError",
	{
		sessionId: Schema.String,
		sandboxInstanceId: SandboxInstance.ID,
		directory: Schema.String,
	},
) {}

export class ModelNotFoundError extends Schema.TaggedError<ModelNotFoundError>()("Runner.ModelNotFoundError", {
	provider: Schema.String,
	model: Schema.String,
}) {}

export class ProviderTurnError extends Schema.TaggedError<ProviderTurnError>()("Runner.ProviderTurnError", {
	provider: Schema.String,
	model: Schema.String,
	cause: Schema.Defect(),
}) {}

export class LLMStreamError extends Schema.TaggedError<LLMStreamError>()("Runner.LLMStreamError", {
	sessionId: Schema.String,
	reason: Schema.String,
}) {}

export class TurnError extends Schema.TaggedError<TurnError>()("Runner.TurnError", {
	sessionId: Schema.String,
	messageId: optional(SessionMessageSchema.ID),
	cause: EventList.TurnAbortCause,
}) {}

export type RunError =
	| ModelNotFoundError
	| ProviderTurnError
	| LLMStreamError
	| TurnError
	| ContextDecodeError
	| ContextEncodeError
	| SessionNotFoundError
	| State.SnapshotError
	| SandboxDirectoryNotFoundError
	| SandboxMountError
	| SandboxFileSystem.FileSystemError;

export interface Interface {
	/** Drains eligible durable work. Explicit runs perform one provider attempt even when no work is eligible. */
	readonly run: (input: {
		readonly sessionId: SessionId;
		readonly force: boolean;
	}) => Effect.Effect<void, RunError, SandboxIO.Provides | Location.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/runner/run/Service") {}

export * as Runner from "./run.ts";
