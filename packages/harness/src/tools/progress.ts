import { Context, Effect, Layer } from "effect";
import type { ModelContent } from "./tool.ts";

/**
 * `ToolProgress` — the side-channel a long-running tool (e.g. streaming bash)
 * writes interim output to, instead of an `onUpdate` callback.
 *
 * Most tools never call `report` and keep a clean `Effect<Success, Failure>`
 * signature. Throttling / coalescing lives in the Layer (the live one routes to
 * the run's event PubSub, tagged with the active callID); the handler just
 * reports.
 */

/** Mirror of aikit's `Message.ToolRunningPartial` (kept structural to stay decoupled). */
export interface ToolProgressPartial {
	readonly content?: ModelContent;
	readonly details?: unknown;
}

export interface IToolProgress {
	readonly report: (partial: ToolProgressPartial) => Effect.Effect<void>;
}

export class ToolProgress extends Context.Service<ToolProgress, IToolProgress>()("@codework/tool/progress") {}

/** Build a `ToolProgress` Layer from a `report` implementation. */
export const make = (report: IToolProgress["report"]): Layer.Layer<ToolProgress> =>
	Layer.succeed(ToolProgress, ToolProgress.of({ report }));

/** Drops every update — the default until the executor wires a live event sink. */
export const noop: Layer.Layer<ToolProgress> = make(() => Effect.void);
