/*
 * @file Tool state carried by a transcript.
 *
 * `Context.tools` is the tool set at the start of the conversation. Each system message
 * changes it from its position on, so replaying them in order yields the tools available
 * now. Providers either declare those changes in place, which keeps the cached prefix, or
 * fold them into the top-level tool list.
 */

import type { Context, Message, SystemMessage, Tool, ToolReference } from "./message.ts";

type Transcript = Pick<Context, "tools" | "messages">;

function isSystemMessage(message: Message): message is SystemMessage {
	return message.role === "system";
}

/** The tool changes in order, led by `Context.tools` as the initial declaration. */
function toolDeclarations(context: Transcript): Pick<SystemMessage, "toolsAdded" | "toolsRemoved">[] {
	return [{ toolsAdded: context.tools ?? [] }, ...context.messages.filter(isSystemMessage)];
}

function replay(declarations: ReadonlyArray<Pick<SystemMessage, "toolsAdded" | "toolsRemoved">>): Tool[] {
	const tools = new Map<string, Tool>();
	for (const declaration of declarations) {
		for (const tool of declaration.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of declaration.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

/** The tools available after applying every transcript change in order. */
export function getCurrentTools(context: Transcript): Tool[] {
	return replay(toolDeclarations(context));
}

/**
 * Every tool the transcript ever declared, the latest definition of each name winning. Removals
 * are ignored: a removed tool's earlier calls still replay in the form it was called in.
 */
export function getDeclaredTools(context: Transcript): Tool[] {
	const tools = new Map<string, Tool>();
	for (const declaration of toolDeclarations(context)) {
		for (const tool of declaration.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

/** Strip a tool to what the model sees, for comparison and persistence. */
export function toToolDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as Tool["parameters"],
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
}

/**
 * Whether two tools declare the same interface to the model. The JSON round trip in
 * {@link toToolDeclaration} drops typebox symbol keys and `undefined` fields and fixes the key
 * order, so comparing the serialized declarations is exact.
 */
export function declarationsEqual(left: Tool, right: Tool): boolean {
	return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}

export interface ToolStateChanges {
	toolsAdded: Tool[];
	toolsRemoved: ToolReference[];
}

/** Compare two complete tool states. A changed definition is a removal followed by an addition. */
export function getToolStateChanges(previous: readonly Tool[], current: readonly Tool[]): ToolStateChanges {
	const previousTools = new Map(previous.map((tool) => [tool.name, tool]));
	const currentTools = new Map(current.map((tool) => [tool.name, tool]));
	return {
		toolsAdded: current
			.filter((tool) => {
				const previousTool = previousTools.get(tool.name);
				return previousTool === undefined || !declarationsEqual(previousTool, tool);
			})
			.map(toToolDeclaration),
		toolsRemoved: previous
			.filter((tool) => {
				const currentTool = currentTools.get(tool.name);
				return currentTool === undefined || !declarationsEqual(tool, currentTool);
			})
			.map((tool) => ({ name: tool.name })),
	};
}

/** Index of the last declaration with a removal or same-name redeclaration, or -1. */
function lastNonAdditiveChange(declarations: ReadonlyArray<Pick<SystemMessage, "toolsAdded" | "toolsRemoved">>) {
	// A name declared before counts as a redeclaration even after its removal: a removed tool
	// declared again later is not reliably picked up again.
	const declared = new Set<string>();
	let last = -1;
	for (const [index, declaration] of declarations.entries()) {
		if ((declaration.toolsRemoved?.length ?? 0) > 0) last = index;
		for (const tool of declaration.toolsAdded ?? []) {
			if (declared.has(tool.name)) last = index;
			declared.add(tool.name);
		}
	}
	return last;
}

/**
 * How a transport can express tool changes after the first request.
 *
 * - `"none"`: only the top-level tool list exists; it always holds the current tools.
 * - `"additions"`: tools can be added at a later message, but not removed or redefined.
 * - `"changes"`: every tool, including the initial ones, is declared in place, and a later
 *   declaration under the same name replaces the earlier one. Removals are not expressible on
 *   the wire, so the transport announces them as text and the removed tools stay declared.
 */
export type TranscriptToolSupport = "none" | "additions" | "changes";

export interface TranscriptTools {
	/** Tools sent in the top-level request field. */
	requestTools: Tool[];
	/** Whether `Context.tools` is declared in place at the head of the input instead of top-level. */
	initialToolsInPlace: boolean;
	/**
	 * Number of leading transcript system messages whose changes `requestTools` already holds.
	 * Every later system message declares its changes in place.
	 */
	foldedSystemMessages: number;
}

/**
 * Split tool declarations between the top-level request field and in-place changes.
 *
 * With `"changes"`, the top-level list stays empty and every declaration, including
 * `Context.tools`, goes in place: an in-place declaration can replace an earlier in-place one,
 * but not a top-level one. With `"additions"`, a removal or redefinition cannot be expressed in
 * place, so the top-level list becomes the tool state after the last such change; later
 * additions stay in place, and the cached prefix is invalidated once per removal instead of on
 * every later addition. With `"none"`, the top-level list is the current tool set.
 */
export function resolveTranscriptTools(context: Transcript, support: TranscriptToolSupport): TranscriptTools {
	const declarations = toolDeclarations(context);
	const transcriptMessages = declarations.length - 1;
	if (support === "none") {
		return {
			requestTools: replay(declarations),
			initialToolsInPlace: false,
			foldedSystemMessages: transcriptMessages,
		};
	}
	if (support === "changes") return { requestTools: [], initialToolsInPlace: true, foldedSystemMessages: 0 };
	const folded = Math.max(1, lastNonAdditiveChange(declarations) + 1);
	return {
		requestTools: replay(declarations.slice(0, folded)),
		initialToolsInPlace: false,
		foldedSystemMessages: folded - 1,
	};
}
