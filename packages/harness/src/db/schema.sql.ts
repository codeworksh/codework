import { Schema } from "effect";
import { Model } from "effect/unstable/schema";
import { AbsolutePath } from "../schema";

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
	"synthetic", // message-shaped, own part rows
	"compaction",
	"branchSummary", // context entries, lowered to user text
	"custom",
	"configChange", // non-context entries
] as const;
export type EntryType = (typeof entryTypes)[number];

// Entry types whose message parts are normalized into session_entry_part rows.
export const messageEntryTypes = ["user", "assistant", "synthetic"] as const;
export type MessageEntryType = (typeof messageEntryTypes)[number];

// Part discriminant: aikit wire literals, verbatim — the column value always
// equals json_extract(data, '$.type').
export const partTypes = ["text", "image", "thinking", "toolCall"] as const;
export type PartType = (typeof partTypes)[number];

// aikit ToolStatusEnum, verbatim. "running" is never persisted in v0 (live-UI
// only) but stays in the vocabulary so persisting live progress later needs no
// migration; read-side code treats it like "pending" (unsettled).
export const toolStatuses = ["pending", "running", "completed", "error", "skipped", "aborted"] as const;
export type ToolStatus = (typeof toolStatuses)[number];

// Column names derive from field names via the client's camelToSnake
// transform, so `sandboxEnvId` (not `sandboxEnvID`) maps to `sandbox_env_id`.
export class ProjectRow extends Model.Class<ProjectRow>("ProjectRow")({
	id: Schema.String,
	name: Schema.String,
	...Timestamps,
}) {}

export class ProjectDirectoryRow extends Model.Class<ProjectDirectoryRow>("ProjectDirectoryRow")({
	id: Schema.String,
	projectId: Schema.String,
	directory: Schema.String,
	type: Schema.Literals(["main", "root", "gitworktree"]),
	sandboxEnvId: Schema.String,
	...Timestamps,
}) {}

export class SessionRow extends Model.Class<SessionRow>("SessionRow")({
	id: Schema.String,
	projectId: Schema.String,
	parentId: Model.FieldOption(Schema.String),
	slug: Schema.String,
	directory: AbsolutePath,
	title: Schema.String,
	tag: Schema.String,
	metadata: Model.FieldOption(Model.JsonFromString(Metadata)),
	// Durable leaf cursor: read anchor (path walks leaf→root) and append anchor
	// (new entries attach here). Moved inside every append/branch transaction.
	leafEntryId: Model.FieldOption(Schema.String),
	// Session-lifetime billed usage, mirroring aikit Usage. Bumped in the
	// assistant-append transaction; a cache — assistant envelopes are truth.
	cost: Model.GeneratedByDb(Schema.Number),
	tokensInput: Model.GeneratedByDb(Schema.Int),
	tokensOutput: Model.GeneratedByDb(Schema.Int),
	tokensCacheRead: Model.GeneratedByDb(Schema.Int),
	tokensCacheWrite: Model.GeneratedByDb(Schema.Int),
	...Timestamps,
}) {}

// One timeline/tree node. Identity and `data` are immutable after insert;
// only the annotation columns (`label`, `metadata`) may change. For message
// types (user/assistant/synthetic), `data` holds the aikit message envelope
// (everything except `parts`); parts live in SessionEntryPartRow.
export class SessionEntryRow extends Model.Class<SessionEntryRow>("SessionEntryRow")({
	id: Schema.String,
	sessionId: Schema.String,
	parentId: Model.FieldOption(Schema.String), // tree edge; NULL = root
	seq: Model.GeneratedByDb(Schema.Int), // per-session append order, computed in the INSERT
	type: Schema.Literals(entryTypes),
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
	sessionId: Schema.String, // denormalized for session-scoped queries
	partIndex: Schema.Int, // dense 0..n-1 within the entry; the loop's addressing unit
	type: Schema.Literals(partTypes),
	status: Model.FieldOption(Schema.Literals(toolStatuses)), // toolCall only
	callId: Model.FieldOption(Schema.String), // toolCall only
	toolName: Model.FieldOption(Schema.String), // toolCall only
	data: Schema.String, // verbatim aikit part JSON
	...Timestamps,
}) {}
