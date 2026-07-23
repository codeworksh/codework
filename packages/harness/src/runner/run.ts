/*
 * @file Defines API for actual run implementation (contract)
 * Typically drain wraps the run to be then drained by the coordinator.
 */

import { Context, Effect } from "effect";
import type { ID as SessionId } from "../session/schema";

// TODO: support error union types
export type RunError = Error;

export interface Interface {
	/** Drains eligible durable work. Explicit runs perform one provider attempt even when no work is eligible. */
	readonly run: (input: { readonly sessionId: SessionId; readonly force: boolean }) => Effect.Effect<void, RunError>;
}

export class Service extends Context.Service<Service, Interface>()("@codework/runner/run") {}

export * as Runner from "./run";
