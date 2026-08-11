import type { LanguageModelV3CallOptions, LanguageModelV3ToolChoice, SharedV3Warning } from "@ai-sdk/provider";
import type { TSchema } from "typebox";
import type * as Message from "../../message/message.ts";
import type { OpenAICodexCompatibility } from "./codex-language-model.ts";

export type OpenAICodexTool =
	| {
			type: "function";
			name: string;
			description?: string;
			parameters: Record<string, unknown>;
			strict?: boolean | null;
			defer_loading?: boolean;
	  }
	| {
			type: "custom";
			name: string;
			description?: string;
			format: {
				type: "grammar";
				syntax: "lark" | "regex";
				definition: string;
			};
			defer_loading?: boolean;
	  };

export type OpenAICodexGrammarConstraint = {
	type: "grammar";
	format: "lark" | "regex";
	definition: string;
	inputProperty: string;
};

export type OpenAICodexGrammarInputBuffer = {
	input: string;
	started: boolean;
	closed: boolean;
};

export function appendOpenAICodexGrammarInputJsonDelta(
	buffer: OpenAICodexGrammarInputBuffer,
	inputProperty: string,
	nextInput: string,
	close: boolean,
): string | undefined {
	if (buffer.closed) {
		if (close && nextInput === buffer.input) return undefined;
		throw new Error(`grammar tool input for property "${inputProperty}" changed after it was closed`);
	}
	if (!nextInput.startsWith(buffer.input)) {
		throw new Error(`grammar tool input for property "${inputProperty}" changed non-monotonically`);
	}

	const inputDelta = nextInput.slice(buffer.input.length);
	if (!close && inputDelta.length === 0) return undefined;

	let delta = "";
	if (!buffer.started) {
		delta += `{${JSON.stringify(inputProperty)}:"`;
		buffer.started = true;
	}
	delta += JSON.stringify(inputDelta).slice(1, -1);
	buffer.input = nextInput;

	if (close) {
		delta += '"}';
		buffer.closed = true;
	}
	return delta;
}

type JsonSchemaObject = {
	type?: unknown;
	properties?: Record<string, { type?: unknown } | undefined>;
	required?: unknown;
};

function inferGrammarInputProperty(parameters: TSchema): string {
	const schema = parameters as JsonSchemaObject;
	if (schema.type !== "object") throw new Error("grammar constrained sampling requires an object parameter schema");
	if (!Array.isArray(schema.required) || schema.required.length !== 1 || typeof schema.required[0] !== "string") {
		throw new Error("grammar constrained sampling requires exactly one required string property");
	}
	const inputProperty = schema.required[0];
	if (!schema.properties?.[inputProperty]) {
		throw new Error(`grammar constrained sampling requires a properties entry for ${inputProperty}`);
	}
	if (schema.properties[inputProperty]?.type !== "string") {
		throw new Error(`grammar constrained sampling property ${inputProperty} must have type string`);
	}
	return inputProperty;
}

export function resolveOpenAICodexToolConstraint(
	tool: Message.Tool,
	compat?: OpenAICodexCompatibility,
): OpenAICodexGrammarConstraint | { type: "json_schema"; strict: true } | undefined {
	const config = tool.constrainedSampling;
	if (!config) return undefined;
	if (config.type === "json_schema") {
		if (compat?.supportsStrictMode ?? true) return { type: "json_schema", strict: true };
		if (config.strict === "require") {
			throw new Error(
				`Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`,
			);
		}
		return undefined;
	}
	if (!(compat?.supportsOpenAIGrammarTools ?? false)) return undefined;

	const lark = config.variants.openai_lark;
	const regex = config.variants.openai_regex;
	const hasLark = typeof lark === "string" && lark.trim().length > 0;
	const hasRegex = typeof regex === "string" && regex.trim().length > 0;
	if (!hasLark && !hasRegex) {
		throw new Error(
			`Tool "${tool.name}" cannot use grammar constrained sampling: no supported grammar variant was provided.`,
		);
	}
	try {
		return {
			type: "grammar",
			format: hasLark ? "lark" : "regex",
			definition: hasLark ? lark! : regex!,
			inputProperty: inferGrammarInputProperty(tool.parameters),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Tool "${tool.name}" cannot use grammar constrained sampling: ${message}.`);
	}
}

export const openAICodexTools = {
	custom<TParameters extends TSchema>(args: {
		name: string;
		description: string;
		parameters: TParameters;
		format: { type: "grammar"; syntax: "lark" | "regex"; definition: string };
	}): Message.Tool<TParameters> {
		return {
			name: args.name,
			description: args.description,
			parameters: args.parameters,
			constrainedSampling: {
				type: "grammar",
				variants:
					args.format.syntax === "lark"
						? { openai_lark: args.format.definition }
						: { openai_regex: args.format.definition },
			},
		};
	},
};

export type OpenAICodexToolChoice = "auto" | "none" | "required";
export type OpenAICodexDeferredToolsMode = "additional-tools" | "tool-search";

const TOOL_SEARCH_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);
const ADDITIONAL_TOOLS_MODEL_IDS = new Set(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);

export function resolveOpenAICodexDeferredToolsMode(
	modelId: string,
	compat?: OpenAICodexCompatibility,
): OpenAICodexDeferredToolsMode | undefined {
	const supportsAdditionalTools = compat?.supportsAdditionalTools ?? ADDITIONAL_TOOLS_MODEL_IDS.has(modelId);
	if (supportsAdditionalTools) return "additional-tools";

	const supportsToolSearch = compat?.supportsToolSearch ?? TOOL_SEARCH_MODEL_IDS.has(modelId);
	return supportsToolSearch ? "tool-search" : undefined;
}

export function prepareOpenAICodexTools({
	tools,
	toolChoice,
	deferredToolNames,
}: {
	tools: LanguageModelV3CallOptions["tools"];
	toolChoice: LanguageModelV3ToolChoice | undefined;
	deferredToolNames?: ReadonlySet<string>;
}): {
	codexTools: OpenAICodexTool[] | undefined;
	deferredCodexTools: ReadonlyMap<string, OpenAICodexTool>;
	grammarToolInputProperties: ReadonlyMap<string, string>;
	codexToolChoice: OpenAICodexToolChoice | undefined;
	warnings: SharedV3Warning[];
} {
	const warnings: SharedV3Warning[] = [];
	const deferredCodexTools = new Map<string, OpenAICodexTool>();
	const grammarToolInputProperties = new Map<string, string>();

	if (!tools || tools.length === 0) {
		return {
			codexTools: undefined,
			deferredCodexTools,
			grammarToolInputProperties,
			codexToolChoice: undefined,
			warnings,
		};
	}

	const codexTools: OpenAICodexTool[] = [];
	for (const tool of tools) {
		if (tool.type !== "function") {
			warnings.push({
				type: "unsupported",
				feature: `tool type ${tool.type}`,
				details: `OpenAI Codex only supports function tools; ignoring ${tool.name}.`,
			});
			continue;
		}
		const metadata = tool.providerOptions?.["openai-codex"] as Record<string, unknown> | undefined;
		const grammar = metadata?.grammar as OpenAICodexGrammarConstraint | undefined;
		const codexTool: OpenAICodexTool =
			grammar?.type === "grammar"
				? {
						type: "custom",
						name: tool.name,
						...(tool.description !== undefined && { description: tool.description }),
						format: {
							type: "grammar",
							syntax: grammar.format,
							definition: grammar.definition,
						},
					}
				: {
						type: "function",
						name: tool.name,
						...(tool.description !== undefined && { description: tool.description }),
						parameters: tool.inputSchema as Record<string, unknown>,
						strict: tool.strict ?? null,
					};
		if (grammar?.type === "grammar") grammarToolInputProperties.set(tool.name, grammar.inputProperty);
		if (deferredToolNames?.has(tool.name)) deferredCodexTools.set(tool.name, codexTool);
		else codexTools.push(codexTool);
	}

	let codexToolChoice: OpenAICodexToolChoice | undefined;
	switch (toolChoice?.type) {
		case undefined:
			break;
		case "auto":
		case "none":
		case "required":
			codexToolChoice = toolChoice.type;
			break;
		case "tool":
			warnings.push({
				type: "unsupported",
				feature: "toolChoice tool name",
				details: "OpenAI Codex does not support forcing a specific tool; using 'required' instead.",
			});
			codexToolChoice = "required";
			break;
	}

	return {
		codexTools: codexTools.length > 0 ? codexTools : undefined,
		deferredCodexTools,
		grammarToolInputProperties,
		codexToolChoice,
		warnings,
	};
}
