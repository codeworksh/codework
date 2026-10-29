import { Schema } from "effect";
import { Model } from "effect/schema";
import { EventSchema } from "../event/schema.ts";
import { ProjectSchema } from "../project/schema.ts";
import { SandboxInstance } from "../sandbox/instance.ts";
import { AbsolutePath, NonNegativeInt } from "../schema.ts";
import { Prompt } from "../session/prompt/schema.ts";
import { DocumentSchema } from "../document/schema.ts";
import { SessionSchema } from "../session/schema.ts";
import { ThreadSchema } from "../thread/schema.ts";
import { SpaceSchema } from "../space/schema.ts";

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
export const entryTypes = ["user", "assistant", "synthetic", "system", "compaction", "reset", "custom"] as const;
export type EntryType = (typeof entryTypes)[number];

export const messageEntryTypes = ["user", "assistant", "synthetic"] as const;
export type MessageEntryType = (typeof messageEntryTypes)[number];

// Conversation visibility for one entry. Non-assistant entries are born
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

export const inboxKinds = ["prompt"] as const;
export type InboxKind = (typeof inboxKinds)[number];

export const inputDeliveries = ["steer", "followUp"] as const;
export type InputDelivery = (typeof inputDeliveries)[number];

const EventData = Schema.Record(Schema.String, Schema.Unknown);

// Head of one aggregate's log (aggregate = session), and who holds it.
export class SequenceRow extends Model.Class<SequenceRow>("SequenceRow")({
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
	status: ProjectSchema.Status,
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

// One directory in one env that belongs to a project. `id = hash(env, location)`.
export class SpaceRow extends Model.Class<SpaceRow>("SpaceRow")({
	id: Schema.String,
	projectId: Schema.String,
	location: AbsolutePath,
	kind: SpaceSchema.Kind,
	// Nullable: NULL is the host (same convention as sandboxInstanceId
	// elsewhere). Service-level code sees a plain ID through
	// SandboxInstance.toColumn/fromColumn and never branches on the host.
	env: Model.FieldOption(SandboxInstance.ID),
	status: SpaceSchema.Status,
	...Timestamps,
}) {}

export class SessionRow extends Model.Class<SessionRow>("SessionRow")({
	id: SessionSchema.IDFromDb,
	// Project and env are derived through the space, never denormalised here.
	spaceId: Schema.String,
	slug: Schema.String,
	// Absolute realpath of the sandbox cwd, the default of every thread; at or under `space.location`.
	directory: AbsolutePath,
	// Host anchor for settings and plugins. Absent = no project layer.
	hostDir: Model.FieldOption(AbsolutePath),
	tag: Model.FieldOption(Schema.String),
	metadata: Model.FieldOption(Model.JsonFromString(Metadata)),
	...Timestamps,
}) {}

// One linear transcript of a session. `origin*` is the flattened `ThreadSchema.Origin`.
export class ThreadRow extends Model.Class<ThreadRow>("ThreadRow")({
	id: ThreadSchema.IDFromDb,
	sessionId: SessionSchema.IDFromDb,
	originKind: ThreadSchema.OriginKind,
	originThreadId: Model.FieldOption(ThreadSchema.IDFromDb),
	originEntryId: Model.FieldOption(Schema.String),
	originCallId: Model.FieldOption(Schema.String),
	// Absent until the thread's first own prompt names it.
	title: Model.FieldOption(Schema.String),
	execution: Model.FieldOption(ThreadSchema.Execution),
	restarts: Model.GeneratedByDb(Schema.Int),
	// Billed usage of own entries only, never the inherited prefix. A cache: assistant envelopes are truth.
	cost: Model.GeneratedByDb(Schema.Finite),
	tokensInput: Model.GeneratedByDb(Schema.Int),
	tokensOutput: Model.GeneratedByDb(Schema.Int),
	tokensCacheRead: Model.GeneratedByDb(Schema.Int),
	tokensCacheWrite: Model.GeneratedByDb(Schema.Int),
	createdSeq: NonNegativeInt,
	...Timestamps,
}) {}

// Work addressed to one thread, from admission to delivery. `kind` + `data` is the flattened item;
// pending = neither `promotedSeq` nor `cancelledSeq`.
export class InboxRow extends Model.Class<InboxRow>("InboxRow")({
	id: Schema.String,
	sessionId: SessionSchema.IDFromDb,
	threadId: ThreadSchema.IDFromDb,
	kind: Schema.Literals(inboxKinds),
	data: Model.JsonFromString(Prompt),
	delivery: Schema.Literals(inputDeliveries),
	admittedSeq: Schema.Int,
	promotedSeq: Model.FieldOption(Schema.Int),
	cancelledSeq: Model.FieldOption(Schema.Int),
	createdAt: Model.DateTimeInsertFromNumber,
}) {}

// One transcript record in one thread. Immutable except a draft assistant, whose `data` and
// `state` are filled in place until it is committed or aborted. For message types
// (user/assistant/synthetic), `data` holds the aikit envelope without `parts`.
export class EntryRow extends Model.Class<EntryRow>("EntryRow")({
	id: Schema.String,
	sessionId: SessionSchema.IDFromDb,
	threadId: ThreadSchema.IDFromDb,
	// The creating event. Sparse: events that append nothing leave gaps.
	seq: NonNegativeInt,
	// The event that committed or aborted it; equals `seq` for entries never drafted. Absent while draft.
	committedSeq: Model.FieldOption(NonNegativeInt),
	type: Schema.Literals(entryTypes),
	state: Schema.Literals(entryStates),
	data: Schema.String,
	label: Model.FieldOption(Schema.String),
	metadata: Model.FieldOption(Model.JsonFromString(Metadata)),
	...Timestamps,
}) {}

// One aikit message part. `data` is the verbatim aikit part JSON and is authoritative;
// `status`/`callId`/`toolName` are promoted copies for indexed queries. The only mutation is
// toolCall settlement (data + status), bounded by the turn's commit.
export class EntryPartRow extends Model.Class<EntryPartRow>("EntryPartRow")({
	id: Schema.String,
	entryId: Schema.String,
	// Not the session: restart recovery finds a thread's unsettled calls by index.
	threadId: ThreadSchema.IDFromDb,
	partIndex: Schema.Int,
	type: Schema.Literals(partTypes),
	status: Model.FieldOption(Schema.Literals(toolStatuses)),
	callId: Model.FieldOption(Schema.String),
	toolName: Model.FieldOption(Schema.String),
	data: Schema.String,
	...Timestamps,
}) {}

// JSON state owned by a session (no thread) or a thread. Every change is a revision.
export class DocumentRow extends Model.Class<DocumentRow>("DocumentRow")({
	id: DocumentSchema.ID,
	sessionId: SessionSchema.IDFromDb,
	threadId: Model.FieldOption(ThreadSchema.IDFromDb),
	kind: Schema.String,
	history: Model.FieldOption(DocumentSchema.History),
	fork: Model.FieldOption(DocumentSchema.Fork),
	createdSeq: NonNegativeInt,
	// Set when retired; a new document of the same kind may then be created.
	retiredSeq: Model.FieldOption(NonNegativeInt),
}) {}

// A document's full value at the seq of the event that wrote it. Older versions migrate on read.
export class DocumentRevisionRow extends Model.Class<DocumentRevisionRow>("DocumentRevisionRow")({
	documentId: DocumentSchema.ID,
	seq: NonNegativeInt,
	version: Schema.Int,
	value: Model.JsonFromString(Schema.Record(Schema.String, Schema.Json)),
}) {}
