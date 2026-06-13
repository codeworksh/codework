import type { LanguageModelV3CallOptions, LanguageModelV3ToolChoice, SharedV3Warning } from "@ai-sdk/provider";

export type OpenAICodexTool = {
	type: "function";
	name: string;
	description?: string;
	parameters: Record<string, unknown>;
	strict?: boolean | null;
};

export type OpenAICodexToolChoice = "auto" | "none" | "required";

export function prepareOpenAICodexTools({
	tools,
	toolChoice,
}: {
	tools: LanguageModelV3CallOptions["tools"];
	toolChoice: LanguageModelV3ToolChoice | undefined;
}): {
	codexTools: OpenAICodexTool[] | undefined;
	codexToolChoice: OpenAICodexToolChoice | undefined;
	warnings: SharedV3Warning[];
} {
	const warnings: SharedV3Warning[] = [];

	if (!tools || tools.length === 0) {
		return { codexTools: undefined, codexToolChoice: undefined, warnings };
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
		codexTools.push({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema as Record<string, unknown>,
			strict: null,
		});
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
		codexToolChoice,
		warnings,
	};
}
