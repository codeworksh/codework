import type { Message } from "@codeworksh/aikit";
import { Context } from "effect";

export interface Offer {
	/** Deferred tools the model may call and is not offered yet, in registry order. */
	readonly deferred: ReadonlyArray<Message.Tool>;
}

/**
 * What the current request offers, provided by the executor to every handler. A reference, so a
 * handler reading it keeps `ToolProgress` as its only requirement and registers like any other.
 */
export const ToolOffer = Context.Reference<Offer>("@codeworksh/harness/tool/offer/ToolOffer", {
	defaultValue: () => ({ deferred: [] }),
});
