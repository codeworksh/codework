import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { VariantSchema } from "effect/unstable/schema";
import { SessionInputRow } from "../../db/schema.sql.ts";
import { Event } from "../../event/event.ts";
import { EventList } from "../../event/list.ts";
import { SessionMessageSchema } from "../message/schema.ts";
import { Delivery, Prompt } from "../prompt/schema.ts";
import { SessionSchema } from "../schema.ts";
import { Admitted } from "./schema.ts";

/**
 * Raised when a durable input is already past the lifecycle point being
 * projected -- a second admission of the same id, or a second promotion.
 *
 * It is a defect, not an error: projectors run inside the event commit, so
 * raising it rolls the event back and leaves the store untouched. `admit` and
 * `promote*` then recover by reading the row that won.
 */
export class LifecycleConflict extends Schema.TaggedError<LifecycleConflict>()(
  "SessionInput.LifecycleConflict",
  { id: SessionMessageSchema.ID },
) {}

const isLifecycleConflict = Schema.is(LifecycleConflict);

const fromRow = (row: SessionInputRow): Admitted =>
  Admitted.make({
    admittedSeq: row.admittedSeq,
    id: SessionMessageSchema.ID.make(row.id),
    sessionId: SessionSchema.ID.make(row.sessionId),
    prompt: row.prompt,
    delivery: row.delivery,
    timeCreated: row.createdAt,
    ...(Option.isNone(row.promotedSeq) ? {} : { promotedSeq: row.promotedSeq.value }),
  });

/**
 * Whether a stored input carries the prompt the caller believes it admitted.
 * A retry that reuses an id with different content is a conflict, not an
 * idempotent replay.
 */
export const equivalent = (
  input: Admitted,
  expected: {
    readonly sessionId: SessionSchema.ID;
    readonly prompt: Prompt;
    readonly delivery: Delivery;
  },
) =>
  input.delivery === expected.delivery &&
  input.sessionId === expected.sessionId &&
  Prompt.equivalence(input.prompt, expected.prompt);

const matchesProjection = (
  input: Admitted,
  expected: {
    readonly sessionId: SessionSchema.ID;
    readonly prompt: Prompt;
    readonly delivery: Delivery;
    readonly timeCreated: DateTime.Utc;
  },
) =>
  equivalent(input, expected) &&
  DateTime.toEpochMillis(input.timeCreated) === DateTime.toEpochMillis(expected.timeCreated);

export interface AdmitInput {
  readonly id: SessionMessageSchema.ID;
  readonly sessionId: SessionSchema.ID;
  readonly prompt: Prompt;
  readonly delivery: Delivery;
}

export interface ProjectAdmittedInput extends AdmitInput {
  readonly admittedSeq: number;
  readonly timeCreated: DateTime.Utc;
}

export interface ProjectPromptedInput extends AdmitInput {
  readonly promotedSeq: number;
  readonly timeCreated: DateTime.Utc;
}

export interface Interface {
  readonly find: (id: SessionMessageSchema.ID) => Effect.Effect<Option.Option<Admitted>>;
  /** Records a prompt durably. Re-admitting the same id returns the stored row. */
  readonly admit: (input: AdmitInput) => Effect.Effect<Admitted>;
  /** Projector for `PromptAdmitted`. Runs inside the event commit. */
  readonly projectAdmitted: (input: ProjectAdmittedInput) => Effect.Effect<void>;
  /** Projector for `Prompted`. Runs inside the event commit. */
  readonly projectPrompted: (input: ProjectPromptedInput) => Effect.Effect<void>;
  /** Whether the lane holds an input that has not been promoted yet. */
  readonly hasPending: (sessionId: SessionSchema.ID, delivery: Delivery) => Effect.Effect<boolean>;
  /**
   * Promotes every pending steer admitted at or before `cutoff`, in admission
   * order, and returns how many were promoted. The cutoff keeps a steer that
   * lands mid-promotion out of a request that is already being assembled.
   */
  readonly promoteSteers: (sessionId: SessionSchema.ID, cutoff: number) => Effect.Effect<number>;
  /**
   * Promotes the single oldest pending follow-up, if any. One per run, unlike
   * steers, which is what makes the follow-up lane strictly turn-at-a-time.
   */
  readonly promoteFollowUp: (sessionId: SessionSchema.ID) => Effect.Effect<boolean>;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* Event.Service;

  const findRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: SessionInputRow,
    execute: (id) => sql`SELECT * FROM session_input WHERE id = ${id}`,
  });

  // RETURNING distinguishes "inserted" from "already there" without a
  // preceding read, so the conflict is detected by the write itself.
  const insertRow = SqlSchema.findAll({
    Request: SessionInputRow.insert,
    Result: Schema.Struct({ id: Schema.String }),
    execute: (row) => sql`
      INSERT INTO session_input ${sql.insert(row)}
      ON CONFLICT(id) DO NOTHING
      RETURNING id
    `,
  });

  // `promoted_seq IS NULL` is the guard: it makes promotion a compare-and-set,
  // so a second promotion updates nothing instead of silently re-delivering.
  const promoteRow = SqlSchema.findAll({
    Request: Schema.Struct({
      id: Schema.String,
      sessionId: Schema.String,
      promotedSeq: Schema.Int,
    }),
    Result: SessionInputRow,
    execute: ({ id, sessionId, promotedSeq }) => sql`
      UPDATE session_input SET promoted_seq = ${promotedSeq}
      WHERE id = ${id} AND session_id = ${sessionId} AND promoted_seq IS NULL
      RETURNING *
    `,
  });

  // An input id becomes the entry id once the Loop materializes it, so an
  // existing entry means this input has already graduated out of the queue.
  const selectEntry = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String }),
    execute: (id) => sql`SELECT id FROM session_entry WHERE id = ${id}`,
  });

  const selectPendingOne = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, delivery: Delivery }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ sessionId, delivery }) => sql`
      SELECT id FROM session_input
      WHERE session_id = ${sessionId} AND promoted_seq IS NULL AND delivery = ${delivery}
      LIMIT 1
    `,
  });

  const selectPendingSteers = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, cutoff: Schema.Int }),
    Result: SessionInputRow,
    execute: ({ sessionId, cutoff }) => sql`
      SELECT * FROM session_input
      WHERE session_id = ${sessionId}
        AND promoted_seq IS NULL
        AND delivery = 'steer'
        AND admitted_seq <= ${cutoff}
      ORDER BY admitted_seq
    `,
  });

  const selectPendingFollowUp = SqlSchema.findAll({
    Request: Schema.String,
    Result: SessionInputRow,
    execute: (sessionId) => sql`
      SELECT * FROM session_input
      WHERE session_id = ${sessionId} AND promoted_seq IS NULL AND delivery = 'followUp'
      ORDER BY admitted_seq
      LIMIT 1
    `,
  });

  const find = Effect.fn("SessionInput.find")(function* (id: SessionMessageSchema.ID) {
    return yield* findRow(id).pipe(Effect.map(Option.map(fromRow)));
  }, Effect.orDie);

  const admit = Effect.fn("SessionInput.admit")(function* (input: AdmitInput) {
    // Read before publishing, never inside it: the commit transaction must open
    // with a write, and a stored row makes re-admission a no-op anyway.
    const existing = yield* find(input.id);
    if (Option.isSome(existing)) return existing.value;
    const timestamp = yield* DateTime.now;
    return yield* events
      .publish(EventList.PromptAdmitted, {
        messageId: input.id,
        sessionId: input.sessionId,
        timestamp,
        prompt: input.prompt,
        delivery: input.delivery,
      })
      .pipe(
        Effect.flatMap((event) =>
          event.durable === undefined
            ? Effect.die("Prompt admission event is missing aggregate sequence")
            : Effect.succeed(
                Admitted.make({
                  admittedSeq: event.durable.seq,
                  id: input.id,
                  sessionId: input.sessionId,
                  prompt: input.prompt,
                  delivery: input.delivery,
                  timeCreated: timestamp,
                }),
              ),
        ),
        // Two admissions of one id race: the loser's projector conflicts, its
        // event rolls back, and it adopts the winner's row.
        Effect.catchDefect((defect) =>
          find(input.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die(defect),
                onSome: (stored: Admitted) => Effect.succeed(stored),
              }),
            ),
          ),
        ),
      );
  });

  const projectAdmitted = Effect.fn("SessionInput.projectAdmitted")(function* (
    input: ProjectAdmittedInput,
  ) {
    // Safe to read first here: the commit transaction already opened with the
    // event's sequence bump, so this cannot upgrade a read lock.
    const entry = yield* selectEntry(input.id);
    if (entry.length > 0) return yield* Effect.die(new LifecycleConflict({ id: input.id }));
    const stored = yield* insertRow({
      id: input.id,
      sessionId: input.sessionId,
      prompt: input.prompt,
      delivery: input.delivery,
      admittedSeq: input.admittedSeq,
      promotedSeq: Option.none(),
      createdAt: VariantSchema.Override(input.timeCreated),
    });
    if (stored.length === 0) return yield* Effect.die(new LifecycleConflict({ id: input.id }));
  }, Effect.orDie);

  const projectPrompted = Effect.fn("SessionInput.projectPrompted")(function* (
    input: ProjectPromptedInput,
  ) {
    const updated = yield* promoteRow({
      id: input.id,
      sessionId: input.sessionId,
      promotedSeq: input.promotedSeq,
    });
    const promoted = updated[0];
    if (promoted) {
      if (!matchesProjection(fromRow(promoted), input))
        return yield* Effect.die(new LifecycleConflict({ id: input.id }));
      return;
    }

    // Nothing moved: either this exact promotion is being replayed, or the row
    // is already promoted at a different sequence, which is a conflict.
    const stored = yield* find(input.id);
    if (Option.isSome(stored)) {
      if (!matchesProjection(stored.value, input) || stored.value.promotedSeq !== input.promotedSeq)
        return yield* Effect.die(new LifecycleConflict({ id: input.id }));
      return;
    }

    // Promotion of an input this store never admitted -- replayed onto an empty
    // projection. Both sequences collapse onto the promotion.
    yield* insertRow({
      id: input.id,
      sessionId: input.sessionId,
      prompt: input.prompt,
      delivery: input.delivery,
      admittedSeq: input.promotedSeq,
      promotedSeq: Option.some(input.promotedSeq),
      createdAt: VariantSchema.Override(input.timeCreated),
    });
  }, Effect.orDie);

  // Publishing `Prompted` is what promotes: the projector stamps promoted_seq
  // with that event's own sequence, so delivery order lives in the same space
  // as the rest of the session's history.
  const publishPrompted = Effect.fn("SessionInput.publishPrompted")(function* (
    sessionId: SessionSchema.ID,
    rows: ReadonlyArray<SessionInputRow>,
  ) {
    for (const row of rows) {
      const id = SessionMessageSchema.ID.make(row.id);
      yield* events
        .publish(EventList.Prompted, {
          sessionId,
          timestamp: row.createdAt,
          messageId: id,
          prompt: row.prompt,
          delivery: row.delivery,
        })
        .pipe(
          // Someone else promoted this row first. That is the intended outcome,
          // so long as it really is promoted now.
          Effect.catchDefect((defect) =>
            isLifecycleConflict(defect)
              ? find(id).pipe(
                  Effect.flatMap((stored) =>
                    Option.isSome(stored) && stored.value.promotedSeq !== undefined
                      ? Effect.void
                      : Effect.die(defect),
                  ),
                )
              : Effect.die(defect),
          ),
        );
    }
    return rows.length;
  });

  const hasPending = Effect.fn("SessionInput.hasPending")(function* (
    sessionId: SessionSchema.ID,
    delivery: Delivery,
  ) {
    const rows = yield* selectPendingOne({ sessionId, delivery });
    return rows.length > 0;
  }, Effect.orDie);

  const promoteSteers = Effect.fn("SessionInput.promoteSteers")(function* (
    sessionId: SessionSchema.ID,
    cutoff: number,
  ) {
    const rows = yield* selectPendingSteers({ sessionId, cutoff }).pipe(Effect.orDie);
    return yield* publishPrompted(sessionId, rows);
  });

  const promoteFollowUp = Effect.fn("SessionInput.promoteFollowUp")(function* (
    sessionId: SessionSchema.ID,
  ) {
    const rows = yield* selectPendingFollowUp(sessionId).pipe(Effect.orDie);
    if (rows.length === 0) return false;
    yield* publishPrompted(sessionId, rows);
    return true;
  });

  return {
    find,
    admit,
    projectAdmitted,
    projectPrompted,
    hasPending,
    promoteSteers,
    promoteFollowUp,
  } satisfies Interface;
});

export * as SessionInput from "./input.ts";
