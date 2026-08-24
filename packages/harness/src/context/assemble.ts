import { Message, Model } from "@codeworksh/aikit";
import { DateTime, Effect, Schema } from "effect";
import { optional } from "../schema.ts";
import { SessionSchema } from "../session/schema.ts";
import type { Session } from "../session/session.ts";
import { decodeMessage, decodeSyntheticMessage } from "./codec.ts";
import { ContextDecodeError } from "./errors.ts";

export interface EffectiveConfig {
	readonly model?: {
		readonly providerId: string;
		readonly modelId: string;
	};
	readonly thinkingLevel?: Model.ThinkingLevel;
}

export interface Snapshot {
	readonly sessionId: string;
	readonly leafEntryId: string | null;
	readonly messages: ReadonlyArray<Message.Message>;
	readonly config: EffectiveConfig;
	readonly lastAssistant?: {
		readonly entryId: string;
		readonly message: Message.AssistantMessage;
	};
}

const SyntheticData = Schema.fromJsonString(
	Schema.Struct({
		messageId: Schema.String,
		customType: Schema.String,
		display: Schema.Boolean,
		details: optional(Schema.Unknown),
	}),
);

const BranchSummaryData = Schema.fromJsonString(
	Schema.Struct({
		fromEntryId: Schema.String,
		summary: Schema.String,
		details: optional(Schema.Unknown),
	}),
);

const CustomData = Schema.fromJsonString(
	Schema.Struct({
		customType: Schema.String,
		data: optional(Schema.Unknown),
	}),
);

const ConfigChangeData = Schema.fromJsonString(
	Schema.Struct({
		model: optional(
			Schema.Struct({
				providerId: Schema.String,
				modelId: Schema.String,
			}),
		),
		thinkingLevel: optional(Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
	}),
);

const decodeSyntheticData = Schema.decodeUnknownEffect(SyntheticData);
const decodeCompactionData = Schema.decodeUnknownEffect(SessionSchema.CompactionData);
const decodeBranchSummaryData = Schema.decodeUnknownEffect(BranchSummaryData);
const decodeCustomData = Schema.decodeUnknownEffect(CustomData);
const decodeConfigChangeData = Schema.decodeUnknownEffect(ConfigChangeData);

const decodeFailure = (entry: Session.HydratedEntry) => (error: { readonly message: string }) =>
	new ContextDecodeError({
		entryId: entry.entry.id,
		type: entry.entry.type,
		reason: error.message,
	});

// TODO(sanchitrk):
// comeback to this when we've decided on compaction, branch summary, etc.

const compactionText = (summary: string) =>
	`The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`;

const branchSummaryText = (summary: string) =>
	`The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${summary}\n</summary>`;

const wrapperMessage = (entry: Session.HydratedEntry, text: string): Message.UserMessage =>
	Message.createUserMessage({
		messageId: entry.entry.id,
		role: "user",
		time: { created: DateTime.toEpochMillis(entry.entry.createdAt) },
		parts: [{ type: "text", text }],
	});

// assembles entries which builds the LLM context.
// a entry is hybrid data type; with entry types not relevant to the LLMs
// yet stored into the timeline.
//
// NOTE(sanchitrk):
// remove unnecessary cases. comeback to this when in use.
export const assemblePath = Effect.fn("Context.assemblePath")(function* (
	sessionId: string,
	path: ReadonlyArray<Session.HydratedEntry>,
): Effect.fn.Return<Snapshot, ContextDecodeError> {
	const leafEntryId = path.at(-1)?.entry.id ?? null;
	const committedPath = path.filter((hydrated) => hydrated.entry.state === "committed");
	let model: EffectiveConfig["model"];
	let thinkingLevel: Model.ThinkingLevel | undefined;
	let lastAssistant: Snapshot["lastAssistant"];
	let latestCompaction: { readonly index: number; readonly data: SessionSchema.CompactionData } | undefined;

	const messagesByEntry = new Map<string, Message.Message>();
	const compactions = new Map<string, SessionSchema.CompactionData>();
	const branchSummaries = new Map<string, string>();

	for (const [index, hydrated] of committedPath.entries()) {
		const { entry } = hydrated;
		if (entry.sessionId !== sessionId) {
			return yield* new ContextDecodeError({
				entryId: entry.id,
				type: entry.type,
				reason: `entry belongs to session ${entry.sessionId}, not ${sessionId}`,
			});
		}

		switch (entry.type) {
			case "user": {
				messagesByEntry.set(entry.id, yield* decodeMessage(hydrated));
				break;
			}
			case "assistant": {
				const message = yield* decodeMessage(hydrated);
				if (message.role !== "assistant") {
					return yield* new ContextDecodeError({
						entryId: entry.id,
						type: entry.type,
						reason: "assistant entry decoded to a non-assistant message",
					});
				}
				messagesByEntry.set(entry.id, message);
				model = { providerId: message.provider.id, modelId: message.model };
				lastAssistant = { entryId: entry.id, message };
				break;
			}
			case "synthetic": {
				const data = yield* decodeSyntheticData(entry.data).pipe(Effect.mapError(decodeFailure(hydrated)));
				if (data.messageId !== entry.id) {
					return yield* new ContextDecodeError({
						entryId: entry.id,
						type: entry.type,
						reason: `messageId "${data.messageId}" does not match entry id`,
					});
				}
				messagesByEntry.set(entry.id, yield* decodeSyntheticMessage(hydrated));
				break;
			}
			case "compaction": {
				const data = yield* decodeCompactionData(entry.data).pipe(Effect.mapError(decodeFailure(hydrated)));
				compactions.set(entry.id, data);
				latestCompaction = { index, data };
				break;
			}
			case "branchSummary": {
				const data = yield* decodeBranchSummaryData(entry.data).pipe(Effect.mapError(decodeFailure(hydrated)));
				branchSummaries.set(entry.id, data.summary);
				break;
			}
			case "custom": {
				yield* decodeCustomData(entry.data).pipe(Effect.mapError(decodeFailure(hydrated)));
				break;
			}
			case "configChange": {
				const data = yield* decodeConfigChangeData(entry.data).pipe(Effect.mapError(decodeFailure(hydrated)));
				if (data.model !== undefined) model = data.model;
				if (data.thinkingLevel !== undefined) thinkingLevel = data.thinkingLevel;
				break;
			}
		}
	}

	let effectivePath = committedPath;
	if (latestCompaction !== undefined) {
		const { index, data } = latestCompaction;
		let kept: ReadonlyArray<Session.HydratedEntry> = [];
		if (data.firstKeptEntryId !== null) {
			const firstKeptIndex = committedPath.findIndex((item) => item.entry.id === data.firstKeptEntryId);
			if (firstKeptIndex < 0 || firstKeptIndex >= index) {
				const entry = committedPath[index]!;
				return yield* new ContextDecodeError({
					entryId: entry.entry.id,
					type: entry.entry.type,
					reason: `firstKeptEntryId "${data.firstKeptEntryId}" is not before the compaction on its path`,
				});
			}
			kept = committedPath.slice(firstKeptIndex, index);
		}
		effectivePath = [committedPath[index]!, ...kept, ...committedPath.slice(index + 1)];
	}

	const messages: Message.Message[] = [];
	for (const hydrated of effectivePath) {
		const { entry } = hydrated;
		const message = messagesByEntry.get(entry.id);
		if (message !== undefined) {
			messages.push(message);
			continue;
		}
		const compaction = compactions.get(entry.id);
		if (compaction !== undefined) {
			messages.push(wrapperMessage(hydrated, compactionText(compaction.summary)));
			continue;
		}
		const branchSummary = branchSummaries.get(entry.id);
		if (branchSummary !== undefined) {
			messages.push(wrapperMessage(hydrated, branchSummaryText(branchSummary)));
		}
	}

	return {
		sessionId,
		leafEntryId,
		messages,
		config: {
			...(model === undefined ? {} : { model }),
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		},
		...(lastAssistant === undefined ? {} : { lastAssistant }),
	};
});

export * as ContextAssembly from "./assemble.ts";
