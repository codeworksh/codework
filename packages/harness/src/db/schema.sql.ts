import { Schema } from "effect";
import { Model } from "effect/unstable/schema";
import { EventSchema } from "../event/schema.ts";
import { SandboxInstance } from "../sandbox/instance.ts";
import { AbsolutePath, NonNegativeInt } from "../schema.ts";
import { Prompt } from "../session/prompt/schema.ts";
import { SessionSchema } from "../session/schema.ts";

// Column names derive from field names via the client's camelToSnake

// DateTime fields encoded as millisecond integers; filled with the current
// time on insert (createdAt) and on every insert/update (updatedAt).
export const Timestamps = {
	createdAt: Model.DateTimeInsertFromNumber,
	updatedAt: Model.DateTimeUpdateFromNumber,
};

const Metadata = Schema.Record(Schema.String, Schema.String);

// Session entry discriminant. Frozen once shipped — values live in persisted
// rows, so a rename is a data migration. Additions are code-only (the column is unconstrained TEXT).
export const entryTypes = [
	"user",
	"assistant",
	"synthetic",
	"compaction",
	"branchSummary",
	"custom",
	"configChange",
] as const;
export type EntryType = (typeof entryTypes)[number];

export const messageEntryTypes = ["user", "assistant", "synthetic"] as const;
export type MessageEntryType = (typeof messageEntryTypes)[number];

// Conversation visibility for one tree node. Non-assistant entries are born
// committed; an assistant alone moves draft -> committed | aborted.
export const entryStates = ["draft", "committed", "aborted"] as const;
export type EntryState = (typeof entryStates)[number];

// Part discriminant: aikit wire literals, verbatim — the column value always
// equals json_extract(data, '$.type').
export const partTypes = ["text", "image", "thinking", "toolCall"] as const;
export type PartType = (typeof partTypes)[number];

// aikit ToolStatusEnum, verbatim. "running" is never persisted in v0 (live-UI only)
// but stays in the vocabulary so persisting live progress later needs no
// migration; read-side code treats it like "pending" (unsettled).
export const toolStatuses = ["pending", "running", "completed", "error", "skipped", "aborted"] as const;
export type ToolStatus = (typeof toolStatuses)[number];

export const inputDeliveries = ["steer", "followUp"] as const;
export type InputDelivery = (typeof inputDeliveries)[number];

const EventData = Schema.Record(Schema.String, Schema.Unknown);

// Head of the event sequence
export class EventSequenceRow extends Model.Class<EventSequenceRow>("EventSequenceRow")({
	aggregateId: Schema.String,
	seq: Schema.Natural,
	ownerId: Model.FieldOption(Schema.String),
}) {}

// Event with contigous sequence
export class EventRow extends Model.Class<EventRow>("EventRow")({
	id: EventSchema.ID,
	aggregateId: Schema.String,
	seq: Schema.Natural,
	type: Schema.String,
	data: Model.JsonFromString(EventData),
}) {}

export class ProjectRow extends Model.Class<ProjectRow>("ProjectRow")({
	id: Schema.String,
	name: Schema.String,
	...Timestamps,
}) {}

/**
 * A durable filesystem namespace. The row is the whole durable model — reference
 * counts live in control-plane memory, never here, because a persisted count
 * cannot tell whether the process that took it is still alive.
 *
 * The host has no row: `local` is reserved and `NULL` is its storage form, so
 * this table only ever holds namespaces something had to provision.
 */
export class SandboxInstanceRow extends Model.Class<SandboxInstanceRow>("SandboxInstanceRow")({
	id: SandboxInstance.ID,
	driver: Schema.String,
	kind: SandboxInstance.Kind,
	providerResourceId: Model.FieldOption(Schema.String),
	runtimeConfig: Model.FieldOption(Schema.String),
	ownership: SandboxInstance.Ownership,
	status: SandboxInstance.Status,
	providerStatus: Model.FieldOption(Schema.String),
	stateObservedAt: Model.DateTimeFromNumberWithNow,
	metadata: Model.FieldOption(Model.JsonFromString(Metadata)),
	lastError: Model.FieldOption(Model.JsonFromString(SandboxInstance.PersistedError)),
	lastMountedAt: Model.FieldOption(Schema.DateTimeUtcFromMillis),
	lastUnmountedAt: Model.FieldOption(Schema.DateTimeUtcFromMillis),
	lastUsedAt: Model.FieldOption(Schema.DateTimeUtcFromMillis),
	removedAt: Model.FieldOption(Schema.DateTimeUtcFromMillis),
	...Timestamps,
}) {}

export class ProjectDirectoryRow extends Model.Class<ProjectDirectoryRow>("ProjectDirectoryRow")({
	id: Schema.String,
	projectId: Schema.String,
	directory: AbsolutePath,
	type: Schema.Literals(["main", "root", "gitworktree"]),
	// Nullable: NULL is the host. Service-level code sees a plain ID through
	// SandboxInstance.toColumn/fromColumn and never branches on the host.
	sandboxInstanceId: Model.FieldOption(SandboxInstance.ID),
	...Timestamps,
}) {}

export class SessionRow extends Model.Class<SessionRow>("SessionRow")({
	id: SessionSchema.IDFromDb,
	projectId: Schema.String,
	parentId: Model.FieldOption(SessionSchema.IDFromDb),
	slug: Schema.String,
	directory: AbsolutePath,
	title: Schema.String,
	tag: Model.FieldOption(Schema.String),
	metadata: Model.FieldOption(Model.JsonFromString(Metadata)),
	// Nullable: NULL is the host (§4), so a session can be written before any
	// namespace is registered — the foreign key is skipped on NULL.
	sandboxInstanceId: Model.FieldOption(SandboxInstance.ID),
	// Durable leaf cursor: read anchor (path walks leaf→root) and append anchor
	// (new entries attach here). Moved inside every append/branch transaction.
	leafEntryId: Model.FieldOption(Schema.String),
	// Session-lifetime billed usage, mirroring aikit Usage. Bumped in the
	// assistant-append transaction; a cache — assistant envelopes are truth.
	cost: Model.GeneratedByDb(Schema.Finite),
	tokensInput: Model.GeneratedByDb(Schema.Int),
	tokensOutput: Model.GeneratedByDb(Schema.Int),
	tokensCacheRead: Model.GeneratedByDb(Schema.Int),
	tokensCacheWrite: Model.GeneratedByDb(Schema.Int),
	...Timestamps,
}) {}

// Durable input-queue record. admittedSeq is arrival order; promotedSeq is
// nullable until Control delivers the input to the Loop, then records delivery
// order. Neither sequence is related to session_entry.seq.
export class SessionInputRow extends Model.Class<SessionInputRow>("SessionInputRow")({
	id: Schema.String,
	sessionId: SessionSchema.IDFromDb,
	prompt: Model.JsonFromString(Prompt), // normalized Prompt, stored as JSON
	delivery: Schema.Literals(inputDeliveries),
	admittedSeq: Schema.Int,
	promotedSeq: Model.FieldOption(Schema.Int),
	createdAt: Model.DateTimeInsertFromNumber,
}) {}

// One timeline/tree node. Identity, tree position, and type are immutable.
// A draft assistant's `data` and `state` are filled in place by lifecycle
// projectors; other payloads are immutable. For message types
// (user/assistant/synthetic), `data` holds the aikit message envelope
// (everything except `parts`); parts live in SessionEntryPartRow.
export class SessionEntryRow extends Model.Class<SessionEntryRow>("SessionEntryRow")({
	id: Schema.String,
	sessionId: SessionSchema.IDFromDb,
	parentId: Model.FieldOption(Schema.String), // tree edge; NULL = root
	// Position in the session's durable log: the sequence of the event that
	// produced this entry. Sparse — events that append nothing (a prompt
	// admission, say) leave gaps. Forked entries carry their source positions,
	// which is why the fork seeds the new aggregate above them.
	seq: NonNegativeInt,
	type: Schema.Literals(entryTypes),
	state: Schema.Literals(entryStates),
	data: Schema.String, // JSON: full payload, or message envelope
	label: Model.FieldOption(Schema.String), // annotation: bookmark text
	metadata: Model.FieldOption(Model.JsonFromString(Metadata)), // annotation: engine scratch
	...Timestamps,
}) {}

// One aikit message part. `data` is the verbatim aikit part JSON and is
// authoritative; `status`/`callId`/`toolName` are promoted copies for indexed
// queries, written together with `data`. The only mutation is toolCall
// settlement (data + status), bounded by turn.end.
export class SessionEntryPartRow extends Model.Class<SessionEntryPartRow>("SessionEntryPartRow")({
	id: Schema.String,
	entryId: Schema.String,
	sessionId: SessionSchema.IDFromDb, // denormalized for session-scoped queries
	partIndex: Schema.Int, // dense 0..n-1 within the entry; the loop's addressing unit
	type: Schema.Literals(partTypes),
	status: Model.FieldOption(Schema.Literals(toolStatuses)), // toolCall only
	callId: Model.FieldOption(Schema.String), // toolCall only
	toolName: Model.FieldOption(Schema.String), // toolCall only
	data: Schema.String, // verbatim aikit part JSON
	...Timestamps,
}) {}
