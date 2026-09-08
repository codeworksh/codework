import { Model as AikitModel, type Protocol } from "@codeworksh/aikit";
import { Schema } from "effect";

export const ThinkingLevel = Schema.Literals(Object.values(AikitModel.ThinkingLevelEnum));
export const ToolExecution = Schema.Literals(["sequential", "parallel"]);
export type ToolExecution = typeof ToolExecution.Type;
const Budgets = Schema.Record(
	Schema.Literals(Object.values(AikitModel.ThinkingLevelEnum).filter((level) => level !== "off")),
	Schema.optional(Schema.Finite),
);

/** Aikit does not export its request schema; keep this routing surface checked against its public types. */
export const requestFields = {
	temperature: Schema.optional(Schema.Finite),
	maxTokens: Schema.optional(Schema.Finite),
	cacheRetention: Schema.optional(Schema.Literals(["none", "short", "long"])),
	headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	timeoutMs: Schema.optional(Schema.Finite),
	maxRetries: Schema.optional(Schema.Finite),
	metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
	thinkingBudgets: Schema.optional(Budgets),
	baseURL: Schema.optional(Schema.String),
	method: Schema.optional(Schema.Literals(Object.values(AikitModel.APIMethodEnum))),
} satisfies Record<
	| Exclude<keyof Protocol.CommonOptions, "signal" | "sessionId" | "reasoning" | "apiKey" | "onPayload">
	| "baseURL"
	| "method",
	Schema.Top
>;

const reserved = new Set([
	"toolChoice",
	"activeTools",
	"provider",
	"id",
	"signal",
	"sessionId",
	"reasoning",
	"modelId",
	"apiKey",
	"onPayload",
	"api",
	"npm",
	"providerOptionsKey",
	"compat",
	"thinkingLevelMap",
	"protocol",
]);

export const Block = Schema.StructWithRest(
	Schema.Struct({
		...requestFields,
		thinkingLevel: Schema.optional(ThinkingLevel),
		toolExecution: Schema.optional(ToolExecution),
		contextWindow: Schema.optional(Schema.Finite),
		extras: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)],
).check(
	Schema.makeFilter(
		(value) => Object.keys(value).every((key) => !reserved.has(key)) || "Reserved configuration key in model options",
	),
);
export type Block = typeof Block.Type;

export const Model = Schema.Struct({
	provider: Schema.optional(Schema.String),
	id: Schema.optional(Schema.String),
	thinkingLevel: Schema.optional(ThinkingLevel),
	toolExecution: Schema.optional(ToolExecution),
	thinkingBudgets: Schema.optional(Budgets),
	options: Schema.optional(Block),
	providerOptions: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Block))),
});
export const Patch = Schema.Struct({
	$schema: Schema.optional(Schema.String),
	model: Schema.optional(Model),
});
export type Patch = typeof Patch.Type;

export interface Info {
	readonly model: typeof Model.Type & {
		readonly provider: string;
		readonly id: string;
		readonly thinkingLevel: AikitModel.ThinkingLevel;
		readonly toolExecution: ToolExecution;
	};
}

/** Let aikit supply model-aware generation defaults. */
export const defaults: Info = {
	model: {
		provider: "openai",
		id: "gpt-5.6-luna",
		thinkingLevel: "high",
		toolExecution: "sequential",
		options: { timeoutMs: 3_600_000, maxRetries: 3 },
	},
};
