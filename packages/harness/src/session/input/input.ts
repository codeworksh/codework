import { DateTime, Effect, Option, Schema } from "effect";
import { VariantSchema } from "effect/schema";
import { SqlClient, SqlSchema } from "effect/sql";
import { SessionInputRow } from "../../db/schema.sql.ts";
import { Event } from "../../event/event.ts";
import { EventList } from "../../event/list.ts";
import { SessionMessageSchema } from "../message/schema.ts";
import { Delivery, Prompt } from "../prompt/schema.ts";
import { SessionSchema } from "../schema.ts";
import { DateTimeUtcFromMillis } from "../../schema.ts";
import { Admitted } from "./schema.ts";

/**
 * Raised when a durable input is already past the lifecycle point being
 * projected -- a second admission of the same id, or a second promotion.
 *
 * It is a defect, not an error: projectors run inside the event commit, so
 * raising it rolls the event back and leaves the store untouched. `admit` and
 * `promote*` then recover by reading the row that won.
 */
export class LifecycleConflict extends Schema.TaggedError<LifecycleConflict>()("SessionInput.LifecycleConflict", {
	id: SessionMessageSchema.ID,
}) {}

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
		...(Option.isNone(row.cancelledSeq) ? {} : { cancelledSeq: row.cancelledSeq.value }),
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

export interface ProjectCancelledInput {
	readonly id: SessionMessageSchema.ID;
	readonly sessionId: SessionSchema.ID;
	readonly cancelledSeq: number;
}

export interface ProjectUpdatedInput {
	readonly id: SessionMessageSchema.ID;
	readonly sessionId: SessionSchema.ID;
	readonly prompt?: Prompt | undefined;
	readonly delivery?: Delivery | undefined;
}

/** What `update` changes; an absent field stays as it is. */
export interface UpdatePatch {
	readonly prompt?: Prompt;
	readonly delivery?: Delivery;
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
	/** Projector for `PromptCancelled`. Runs inside the event commit. */
	readonly projectCancelled: (input: ProjectCancelledInput) => Effect.Effect<void>;
	/** Projector for `PromptUpdated`. Runs inside the event commit. */
	readonly projectUpdated: (input: ProjectUpdatedInput) => Effect.Effect<void>;
	/**
	 * Moves a pending input to the other lane, or rewrites it, keeping its place in admission
	 * order. The stored input after the change, or none when it was promoted, cancelled, or unknown.
	 */
	readonly update: (
		sessionId: SessionSchema.ID,
		id: SessionMessageSchema.ID,
		patch: UpdatePatch,
	) => Effect.Effect<Option.Option<Admitted>>;
	/**
	 * Withdraws a pending input of the session. False when there is none by that id, or it was
	 * promoted or cancelled first: a cancel that loses to promotion leaves the prompt in the
	 * conversation.
	 */
	readonly cancel: (sessionId: SessionSchema.ID, id: SessionMessageSchema.ID) => Effect.Effect<boolean>;
	/** Inputs not promoted yet, both lanes, in admission order. */
	readonly pending: (sessionId: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Admitted>>;
	/** Whether the lane holds an input that has not been promoted yet. */
	readonly hasPending: (sessionId: SessionSchema.ID, delivery: Delivery) => Effect.Effect<boolean>;
	/**
	 * Promotes every pending steer admitted at or before `cutoff`, in admission
	 * order. The cutoff keeps a steer that lands mid-promotion out of a request
	 * that is already being assembled.
	 *
	 * Counts promotions *this* caller won. A row another drainer promoted first
	 * is not counted: callers treat a positive count as new work to answer, and
	 * counting a promotion someone else committed would have two workers answer
	 * one prompt.
	 */
	readonly promoteSteers: (sessionId: SessionSchema.ID, cutoff: number) => Effect.Effect<number>;
	/**
	 * Promotes the single oldest pending follow-up, if any. One per run, unlike
	 * steers, which is what makes the follow-up lane strictly turn-at-a-time.
	 * False when there was none, or when another caller promoted it first.
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

	const updateRow = SqlSchema.findAll({
		Request: Schema.Struct({
			id: Schema.String,
			sessionId: Schema.String,
			prompt: Schema.NullOr(Schema.fromJsonString(Prompt)),
			delivery: Schema.NullOr(Delivery),
		}),
		Result: Schema.Struct({ id: Schema.String }),
		// A null field is one the update left alone.
		execute: ({ id, sessionId, prompt, delivery }) => sql`
      UPDATE session_input SET prompt = COALESCE(${prompt}, prompt), delivery = COALESCE(${delivery}, delivery)
      WHERE id = ${id} AND session_id = ${sessionId} AND promoted_seq IS NULL AND cancelled_seq IS NULL
      RETURNING id
    `,
	});

	// A cancelled id may be admitted again: its kept row becomes pending once more, as a fresh admission.
	const reviveRow = SqlSchema.findAll({
		Request: Schema.Struct({
			id: Schema.String,
			sessionId: Schema.String,
			prompt: Schema.fromJsonString(Prompt),
			delivery: Delivery,
			admittedSeq: Schema.Int,
			createdAt: DateTimeUtcFromMillis,
		}),
		Result: Schema.Struct({ id: Schema.String }),
		execute: ({ id, sessionId, prompt, delivery, admittedSeq, createdAt }) => sql`
      UPDATE session_input
      SET prompt = ${prompt}, delivery = ${delivery}, admitted_seq = ${admittedSeq}, created_at = ${createdAt},
        cancelled_seq = NULL
      WHERE id = ${id} AND session_id = ${sessionId} AND promoted_seq IS NULL AND cancelled_seq IS NOT NULL
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
      WHERE id = ${id} AND session_id = ${sessionId} AND promoted_seq IS NULL AND cancelled_seq IS NULL
      RETURNING *
    `,
	});

	// The same compare-and-set as promotion: whichever of the two commits first wins the row.
	const cancelRow = SqlSchema.findAll({
		Request: Schema.Struct({ id: Schema.String, sessionId: Schema.String, cancelledSeq: Schema.Int }),
		Result: Schema.Struct({ id: Schema.String }),
		execute: ({ id, sessionId, cancelledSeq }) => sql`
      UPDATE session_input SET cancelled_seq = ${cancelledSeq}
      WHERE id = ${id} AND session_id = ${sessionId} AND promoted_seq IS NULL AND cancelled_seq IS NULL
      RETURNING id
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
      WHERE session_id = ${sessionId} AND promoted_seq IS NULL AND cancelled_seq IS NULL AND delivery = ${delivery}
      LIMIT 1
    `,
	});

	const selectPending = SqlSchema.findAll({
		Request: Schema.String,
		Result: SessionInputRow,
		execute: (sessionId) => sql`
      SELECT * FROM session_input
      WHERE session_id = ${sessionId} AND promoted_seq IS NULL AND cancelled_seq IS NULL
      ORDER BY admitted_seq
    `,
	});

	const selectPendingSteers = SqlSchema.findAll({
		Request: Schema.Struct({ sessionId: Schema.String, cutoff: Schema.Int }),
		Result: SessionInputRow,
		execute: ({ sessionId, cutoff }) => sql`
      SELECT * FROM session_input
      WHERE session_id = ${sessionId}
        AND promoted_seq IS NULL
        AND cancelled_seq IS NULL
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
      WHERE session_id = ${sessionId} AND promoted_seq IS NULL AND cancelled_seq IS NULL AND delivery = 'followUp'
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
		// A cancelled one is admitted afresh, as if it had never been sent.
		if (Option.isSome(existing) && existing.value.cancelledSeq === undefined) return existing.value;
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
				// event rolls back, and it adopts the winner's row. A row still cancelled
				// means no admission won, so the failure stands.
				Effect.catchDefect((defect) =>
					find(input.id).pipe(
						Effect.flatMap((stored) =>
							Option.isSome(stored) && stored.value.cancelledSeq === undefined
								? Effect.succeed(stored.value)
								: Effect.die(defect),
						),
					),
				),
			);
	});

	const projectAdmitted = Effect.fn("SessionInput.projectAdmitted")(function* (input: ProjectAdmittedInput) {
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
			cancelledSeq: Option.none(),
			createdAt: VariantSchema.Override(input.timeCreated),
		});
		if (stored.length > 0) return;
		const revived = yield* reviveRow({
			id: input.id,
			sessionId: input.sessionId,
			prompt: input.prompt,
			delivery: input.delivery,
			admittedSeq: input.admittedSeq,
			createdAt: input.timeCreated,
		});
		if (revived.length === 0) return yield* Effect.die(new LifecycleConflict({ id: input.id }));
	}, Effect.orDie);

	const projectPrompted = Effect.fn("SessionInput.projectPrompted")(function* (input: ProjectPromptedInput) {
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
			if (
				!matchesProjection(stored.value, input) ||
				stored.value.promotedSeq !== input.promotedSeq ||
				stored.value.cancelledSeq !== undefined
			)
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
			cancelledSeq: Option.none(),
			createdAt: VariantSchema.Override(input.timeCreated),
		});
	}, Effect.orDie);

	const projectCancelled = Effect.fn("SessionInput.projectCancelled")(function* (input: ProjectCancelledInput) {
		const updated = yield* cancelRow(input);
		if (updated.length > 0) return;
		// Nothing moved: this exact cancel being replayed, or the row was promoted or cancelled first.
		const stored = yield* find(input.id);
		if (Option.isSome(stored) && stored.value.cancelledSeq === input.cancelledSeq) return;
		return yield* Effect.die(new LifecycleConflict({ id: input.id }));
	}, Effect.orDie);

	const projectUpdated = Effect.fn("SessionInput.projectUpdated")(function* (input: ProjectUpdatedInput) {
		const updated = yield* updateRow({
			id: input.id,
			sessionId: input.sessionId,
			prompt: input.prompt ?? null,
			delivery: input.delivery ?? null,
		});
		if (updated.length > 0) return;
		// Promoted or cancelled first: the update lost, and its event rolls back.
		return yield* Effect.die(new LifecycleConflict({ id: input.id }));
	}, Effect.orDie);

	const update = Effect.fn("SessionInput.update")(function* (
		sessionId: SessionSchema.ID,
		id: SessionMessageSchema.ID,
		patch: UpdatePatch,
	) {
		// Read before publishing, as `admit` does: the commit must open with a write.
		const stored = yield* find(id);
		if (
			Option.isNone(stored) ||
			stored.value.sessionId !== sessionId ||
			stored.value.promotedSeq !== undefined ||
			stored.value.cancelledSeq !== undefined
		)
			return Option.none<Admitted>();
		const prompt =
			patch.prompt === undefined || Prompt.equivalence(patch.prompt, stored.value.prompt) ? undefined : patch.prompt;
		const delivery =
			patch.delivery === undefined || patch.delivery === stored.value.delivery ? undefined : patch.delivery;
		if (prompt === undefined && delivery === undefined) return stored;
		const timestamp = yield* DateTime.now;
		return yield* events
			.publish(EventList.PromptUpdated, {
				sessionId,
				messageId: id,
				timestamp,
				...(prompt === undefined ? {} : { prompt }),
				...(delivery === undefined ? {} : { delivery }),
			})
			.pipe(
				// Read back: another update may have changed the field this one left alone.
				Effect.andThen(find(id)),
				// Promoted or cancelled between the read and the commit.
				Effect.catchDefect((defect) =>
					isLifecycleConflict(defect) ? Effect.succeed(Option.none<Admitted>()) : Effect.die(defect),
				),
			);
	});

	const cancel = Effect.fn("SessionInput.cancel")(function* (
		sessionId: SessionSchema.ID,
		id: SessionMessageSchema.ID,
	) {
		// Read before publishing, as `admit` does: the commit must open with a write.
		const stored = yield* find(id);
		if (
			Option.isNone(stored) ||
			stored.value.sessionId !== sessionId ||
			stored.value.promotedSeq !== undefined ||
			stored.value.cancelledSeq !== undefined
		)
			return false;
		const timestamp = yield* DateTime.now;
		return yield* events.publish(EventList.PromptCancelled, { sessionId, messageId: id, timestamp }).pipe(
			Effect.as(true),
			// Promoted (or cancelled) between the read and the commit: the projector conflicted and
			// the event rolled back.
			Effect.catchDefect((defect) => (isLifecycleConflict(defect) ? Effect.succeed(false) : Effect.die(defect))),
		);
	});

	// Publishing `Prompted` is what promotes: the projector stamps promoted_seq
	// with that event's own sequence, so delivery order lives in the same space
	// as the rest of the session's history.
	// TODO(sanchitrk): revisit
	const publishPrompted = Effect.fn("SessionInput.publishPrompted")(function* (
		sessionId: SessionSchema.ID,
		rows: ReadonlyArray<SessionInputRow>,
	) {
		let promoted = 0;
		for (const row of rows) {
			const id = SessionMessageSchema.ID.make(row.id);
			const won = yield* events
				.publish(EventList.Prompted, {
					sessionId,
					timestamp: row.createdAt,
					messageId: id,
					prompt: row.prompt,
					delivery: row.delivery,
				})
				.pipe(
					Effect.as(true),
					// Someone else promoted this row first. That is the intended outcome
					// so long as it really is promoted now -- but it is their promotion,
					// not ours, so it does not count as work for this caller.
					Effect.catchDefect((defect) =>
						isLifecycleConflict(defect)
							? find(id).pipe(
									Effect.flatMap((stored) =>
										// Promoted by someone else, cancelled, re-admitted or updated since it was
										// selected; one still pending is read afresh by the next promotion.
										Option.isSome(stored) &&
										(stored.value.promotedSeq !== undefined ||
											stored.value.cancelledSeq !== undefined ||
											stored.value.admittedSeq !== row.admittedSeq ||
											stored.value.delivery !== row.delivery ||
											!Prompt.equivalence(stored.value.prompt, row.prompt))
											? Effect.succeed(false)
											: Effect.die(defect),
									),
								)
							: Effect.die(defect),
					),
				);
			if (won) promoted += 1;
		}
		return promoted;
	});

	const pending = Effect.fn("SessionInput.pending")(function* (sessionId: SessionSchema.ID) {
		return (yield* selectPending(sessionId)).map(fromRow);
	}, Effect.orDie);

	const hasPending = Effect.fn("SessionInput.hasPending")(function* (sessionId: SessionSchema.ID, delivery: Delivery) {
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

	const promoteFollowUp = Effect.fn("SessionInput.promoteFollowUp")(function* (sessionId: SessionSchema.ID) {
		const rows = yield* selectPendingFollowUp(sessionId).pipe(Effect.orDie);
		if (rows.length === 0) return false;
		return (yield* publishPrompted(sessionId, rows)) > 0;
	});

	return {
		find,
		admit,
		projectAdmitted,
		projectPrompted,
		projectCancelled,
		projectUpdated,
		update,
		cancel,
		pending,
		hasPending,
		promoteSteers,
		promoteFollowUp,
	} satisfies Interface;
});

export * as SessionInput from "./input.ts";
