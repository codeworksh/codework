import type {
	LanguageModelV3CallOptions,
	LanguageModelV3FunctionTool,
	LanguageModelV3ToolChoice,
	SharedV3Warning,
} from "@ai-sdk/provider";
import type { TSchema } from "typebox";
import * as Message from "../../message/message.ts";

export type ResponsesTool =
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

export type ResponsesGrammarConstraint = {
	type: "grammar";
	format: "lark" | "regex";
	definition: string;
	inputProperty: string;
};

export type GrammarInputBuffer = {
	input: string;
	started: boolean;
	closed: boolean;
};

export function appendGrammarInputJsonDelta(
	buffer: GrammarInputBuffer,
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

export function resolveToolGrammar(
	tool: Message.Tool,
	compat?: { supportsOpenAIGrammarTools?: boolean },
): ResponsesGrammarConstraint | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "grammar") return undefined;
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
		throw new Error(`tool "${tool.name}" cannot use grammar constrained sampling: ${message}.`);
	}
}

export type ResponsesToolChoice = "auto" | "none" | "required";

/**
 * Tool changes declared at a system message's position, carried in its
 * `providerOptions[<provider>].toolChange`. `changes` declares tools in
 * `additional_tools` items; `additions` declares them as a synthetic tool search.
 */
export type ResponsesToolChange = {
	mode: "changes" | "additions";
	tools: LanguageModelV3FunctionTool[];
	removed: string[];
};

/** A function tool carries its grammar in `providerOptions[<provider>].grammar`. */
function toolGrammar(tool: LanguageModelV3FunctionTool, provider: string): ResponsesGrammarConstraint | undefined {
	const metadata = tool.providerOptions?.[provider] as Record<string, unknown> | undefined;
	const grammar = metadata?.grammar as ResponsesGrammarConstraint | undefined;
	return grammar?.type === "grammar" ? grammar : undefined;
}

export function toResponsesTool(tool: LanguageModelV3FunctionTool, provider: string): ResponsesTool {
	const grammar = toolGrammar(tool, provider);
	return grammar
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
}

export function prepareResponsesTools({
	provider,
	tools,
	toolChoice,
	inPlaceToolNames,
}: {
	provider: string;
	tools: LanguageModelV3CallOptions["tools"];
	toolChoice: LanguageModelV3ToolChoice | undefined;
	/** Tools declared in place in the input; they stay out of the top-level list. */
	inPlaceToolNames?: ReadonlySet<string>;
}): {
	responsesTools: ResponsesTool[] | undefined;
	grammarToolInputProperties: ReadonlyMap<string, string>;
	toolChoiceValue: ResponsesToolChoice | undefined;
	warnings: SharedV3Warning[];
} {
	const warnings: SharedV3Warning[] = [];
	const grammarToolInputProperties = new Map<string, string>();

	if (!tools || tools.length === 0) {
		return {
			responsesTools: undefined,
			grammarToolInputProperties,
			toolChoiceValue: undefined,
			warnings,
		};
	}

	const responsesTools: ResponsesTool[] = [];
	for (const tool of tools) {
		if (tool.type !== "function") {
			warnings.push({
				type: "unsupported",
				feature: `tool type ${tool.type}`,
				details: `Only function tools are supported; ignoring ${tool.name}.`,
			});
			continue;
		}
		const grammar = toolGrammar(tool, provider);
		if (grammar) grammarToolInputProperties.set(tool.name, grammar.inputProperty);
		if (!inPlaceToolNames?.has(tool.name)) responsesTools.push(toResponsesTool(tool, provider));
	}

	let toolChoiceValue: ResponsesToolChoice | undefined;
	switch (toolChoice?.type) {
		case undefined:
			break;
		case "auto":
		case "none":
		case "required":
			toolChoiceValue = toolChoice.type;
			break;
		case "tool":
			warnings.push({
				type: "unsupported",
				feature: "toolChoice tool name",
				details: "Forcing a specific tool is not supported; using 'required' instead.",
			});
			toolChoiceValue = "required";
			break;
	}

	return {
		responsesTools: responsesTools.length > 0 ? responsesTools : undefined,
		grammarToolInputProperties,
		toolChoiceValue,
		warnings,
	};
}
