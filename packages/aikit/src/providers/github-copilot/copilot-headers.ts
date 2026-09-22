/**
 * Copilot request identity.
 *
 * Every inference request must look like it came from the Copilot Chat client:
 * the static headers identify that client, while `x-initiator` and
 * `Copilot-Vision-Request` describe the serialized body.
 */

import { isAnthropicAdaptiveThinkingModel } from "../../model/model.ts";

export const GITHUB_COPILOT_API_VERSION = "2026-08-01";

export const GITHUB_COPILOT_STATIC_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

/** `X-Interaction-Type` is `conversation-{type}`; only `agent` is wired today. */
export type GitHubCopilotInteractionType = "agent" | "subagent" | "background" | "compaction";

// Copilot rejects these betas on adaptive-thinking Claude models.
const ADAPTIVE_UNSUPPORTED_BETAS = new Set([
	"interleaved-thinking-2025-05-14",
	"fine-grained-tool-streaming-2025-05-14",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type RequestMetadata = { agent: boolean; vision: boolean };

function responsesMetadata(input: unknown): RequestMetadata {
	const list = Array.isArray(input) ? input : [];
	const last = list[list.length - 1];
	let vision = false;
	for (const item of list) {
		if (!isRecord(item) || !Array.isArray(item.content)) continue;
		if (item.content.some((part) => isRecord(part) && part.type === "input_image")) vision = true;
	}
	return { agent: isRecord(last) && last.role !== "user", vision };
}

function completionsMetadata(messages: unknown): RequestMetadata {
	const list = Array.isArray(messages) ? messages : [];
	const last = list[list.length - 1];
	let vision = false;
	for (const message of list) {
		if (!isRecord(message) || !Array.isArray(message.content)) continue;
		if (message.content.some((part) => isRecord(part) && part.type === "image_url")) vision = true;
	}
	return { agent: isRecord(last) && last.role !== "user", vision };
}

function messagesMetadata(messages: unknown): RequestMetadata {
	const list = Array.isArray(messages) ? messages : [];
	const last = list[list.length - 1];
	let vision = false;
	for (const message of list) {
		if (!isRecord(message) || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (!isRecord(part)) continue;
			if (part.type === "image") vision = true;
			if (
				part.type === "tool_result" &&
				Array.isArray(part.content) &&
				part.content.some((inner) => isRecord(inner) && inner.type === "image")
			) {
				vision = true;
			}
		}
	}

	const content = isRecord(last) && Array.isArray(last.content) ? last.content : [];
	// A trailing user turn that only carries tool_result parts is still an agent
	// step — it answers a tool call, not a human prompt.
	const agent =
		!isRecord(last) || last.role !== "user" || !content.some((part) => isRecord(part) && part.type !== "tool_result");
	return { agent, vision };
}

/** Derive `x-initiator` and `Copilot-Vision-Request` inputs from the serialized body. */
export function copilotRequestMetadata(url: string, body: unknown): RequestMetadata {
	if (!isRecord(body)) return { agent: false, vision: false };
	if (url.includes("/responses")) return responsesMetadata(body.input);
	if (Array.isArray(body.messages)) {
		return url.includes("/completions") ? completionsMetadata(body.messages) : messagesMetadata(body.messages);
	}
	return { agent: false, vision: false };
}

export function applyCopilotHeaders(
	headers: Headers,
	options: {
		token: string;
		url: string;
		body: unknown;
		sessionId?: string;
		interactionType?: GitHubCopilotInteractionType;
	},
): void {
	// Whatever the adapters configured (API key, x-api-key) is replaced by the
	// resolved Copilot token; OAuth `ghu_`/`gho_` tokens are Bearer credentials.
	headers.delete("authorization");
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${options.token}`);

	for (const [key, value] of Object.entries(GITHUB_COPILOT_STATIC_HEADERS)) {
		headers.set(key, value);
	}
	headers.set("Openai-Intent", "conversation-edits");
	headers.set("X-GitHub-Api-Version", GITHUB_COPILOT_API_VERSION);

	const interactionType = `conversation-${options.interactionType ?? "agent"}`;
	headers.set("X-Interaction-Type", interactionType);
	if (options.sessionId) headers.set("X-Interaction-Id", options.sessionId);

	// `x-initiator` can only escalate to `agent`, never back to `user` — a
	// non-agent interaction or an agent-shaped body overrides a declared `user`.
	if (interactionType !== "conversation-agent") {
		headers.set("x-initiator", "agent");
	}
	const metadata = copilotRequestMetadata(options.url, options.body);
	if (metadata.agent) {
		headers.set("x-initiator", "agent");
	} else if (!headers.has("x-initiator")) {
		headers.set("x-initiator", "user");
	}
	if (metadata.vision) {
		headers.set("Copilot-Vision-Request", "true");
	}

	const model = isRecord(options.body) && typeof options.body.model === "string" ? options.body.model : undefined;
	const beta = headers.get("anthropic-beta");
	if (model && beta && isAnthropicAdaptiveThinkingModel(model)) {
		const kept = beta
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry && !ADAPTIVE_UNSUPPORTED_BETAS.has(entry));
		if (kept.length > 0) {
			headers.set("anthropic-beta", kept.join(","));
		} else {
			headers.delete("anthropic-beta");
		}
	}
}
