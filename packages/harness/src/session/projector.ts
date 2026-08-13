/*
 * @file Registers the durable-input projectors with the event service.
 *
 * Provides no service. Its only purpose is the registration side effect, which
 * must happen exactly once and before anything publishes -- `Layer` gives both,
 * because a layer is built once per graph, at startup.
 *
 * Registering from `SessionInput.make` instead would run once per consumer, and
 * a projector registered twice runs twice on one event: the second insert hits
 * ON CONFLICT, raises LifecycleConflict inside the commit, and rolls the event
 * back. Every admission would fail, blaming a conflict that does not exist.
 *
 * Nothing type-errors if this layer is left out of the graph. `admit` publishes
 * happily and writes no row, so the wiring is worth asserting in a test.
 */

import { Effect, Layer } from "effect";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import { SessionInput } from "./input/input.ts";
import { SessionMessageUpdater } from "./message/updater.ts";
import { Session } from "./session.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* Event.Service;
    const input = yield* SessionInput.make;
    const sessions = yield* Session.Service;

    yield* events.project(EventList.PromptAdmitted, (event) =>
      Effect.gen(function* () {
        // The sequence is assigned by the commit itself, so a durable event
        // arriving without one means it never went through the transaction.
        if (event.durable === undefined)
          return yield* Effect.die("PromptAdmitted is missing its aggregate sequence");
        yield* input.projectAdmitted({
          admittedSeq: event.durable.seq,
          id: event.data.messageId,
          sessionId: event.data.sessionId,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        });
      }),
    );

    // Publishing `Prompted` is what promotes an input, so this registration is
    // what makes `promoteSteers` / `promoteFollowUp` take effect at all.
    yield* events.project(EventList.Prompted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined)
          return yield* Effect.die("Prompted is missing its aggregate sequence");
        yield* input.projectPrompted({
          promotedSeq: event.durable.seq,
          id: event.data.messageId,
          sessionId: event.data.sessionId,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        });
        // Promotion is what puts a prompt into the conversation, so the append
        // belongs in this commit: "promoted but absent from history" is then
        // unrepresentable rather than a window someone has to reconcile.
        //
        // No expectedLeafEntryId. That guard is a compare-and-set for callers
        // that assembled context against a specific leaf and must not append
        // over a concurrent branch; a projector has assembled nothing, and its
        // failures are defects that roll the event back -- so passing it would
        // turn a recoverable conflict into a promotion that never happened.
        // TODO: revisit if concurrent branching during a run becomes possible.
        //
        // The remaining errors are structural (no such session, undecodable
        // entry data, a position that does not advance) and cannot be recovered
        // from here: each means the log and the tree already disagree.
        yield* sessions
          .append(
            SessionMessageUpdater.fromPrompt({
              id: event.data.messageId,
              sessionId: event.data.sessionId,
              seq: event.durable.seq,
              prompt: event.data.prompt,
              timeCreated: event.data.timestamp,
            }),
          )
          .pipe(Effect.orDie);
      }),
    );
  }),
);

export * as SessionProjector from "./projector.ts";
