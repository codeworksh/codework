/*
 * @file The session service with its projections registered.
 *
 * Provide this, not `Session.layer` alone. `Session.prompt` records a prompt by
 * publishing an event, and the row only appears because a projector reacted to
 * it — without `SessionProjector.layer` in the graph the publish succeeds, the
 * inbox stays empty, and nothing errors.
 *
 * Enforces the same thing by listing `SessionProjector.node` in the
 * session service's own `deps`, so the service cannot be built without its
 * projections. That edge is not available here: their projector needs only the
 * database, ours needs `Session.Service` to append entries, so declaring it as a
 * dependency of the session would be a cycle. Composing the pair in one place is
 * the same guarantee reached from the other side.
 */

import { Layer } from "effect";
import { SessionProjector } from "./projector.ts";
import { Session } from "./session.ts";

export const layer = Layer.provideMerge(SessionProjector.layer, Session.layer);

export * as SessionLive from "./live.ts";
