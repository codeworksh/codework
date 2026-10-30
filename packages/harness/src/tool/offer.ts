import type { Message } from "@codeworksh/aikit";
import { Context, Effect } from "effect";

export interface Offer {
	/**
	 * Deferred tools the model may call and is not offered yet: the registry's, in its order, then
	 * any an MCP server offers since the turn started. Waits, bounded, for servers still connecting.
	 */
	readonly deferred: Effect.Effect<ReadonlyArray<Message.Tool>>;
}

/**
 * What the current request offers, provided by the executor to every handler. A reference, so a
 * handler reading it keeps `ToolProgress` as its only requirement and registers like any other.
 */
export const ToolOffer = Context.Reference<Offer>("@codeworksh/harness/tool/offer/ToolOffer", {
	defaultValue: () => ({ deferred: Effect.succeed([]) }),
});
