import "../utils/env.ts";

import { describe, expect, it } from "vite-plus/test";
import { githubCopilotApiMethod } from "../../src/cli/modelgen.ts";
import * as Message from "../../src/message/message.ts";
import * as Model from "../../src/model/model.ts";
import {
	getGitHubCopilotApiKey,
	GitHubCopilotOAuthClient,
	gitHubCopilotBaseUrl,
} from "../../src/oauth/github/copilot.ts";
import { stream } from "../../src/stream.ts";
import { getText } from "../utils/llm.ts";

// gpt-4.1 is callable on every Copilot plan, including Copilot Free — where
// it is typically the only model the account can reach.
const MODEL_ID = "gpt-4.1";

const apiKey = await getGitHubCopilotApiKey();
const credentials = await new GitHubCopilotOAuthClient().getCredentials();
const baseUrl = gitHubCopilotBaseUrl(credentials ?? undefined);
const describeIfGitHubCopilot = apiKey ? describe : describe.skip;

function copilotModel(): Model.TModel<"github-copilot"> {
	return {
		id: MODEL_ID,
		name: MODEL_ID,
		provider: {
			id: "github-copilot",
			name: "GitHub Copilot",
			source: "custom",
			env: ["COPILOT_GITHUB_TOKEN", "GITHUB_TOKEN"],
		},
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		npm: "@codeworksh/ai-sdk-github-copilot",
		api: { id: MODEL_ID, url: baseUrl, method: githubCopilotApiMethod(MODEL_ID) },
		providerOptionsKey: "github-copilot",
		protocol: "github-copilot",
	};
}

function user(text: string): Message.UserMessage {
	return Message.createUserMessage({
		role: "user",
		parts: [{ type: "text", text }],
		time: { created: Date.now() },
	});
}

describeIfGitHubCopilot(`GitHub Copilot ${MODEL_ID}`, () => {
	it("streams text over the Chat Completions route", { retry: 2, timeout: 120_000 }, async () => {
		const responseStream = stream(
			copilotModel(),
			{ messages: [user("Reply with exactly the word parity.")] },
			{ apiKey: apiKey!, maxTokens: 64 },
		);
		const response = await responseStream.result();

		expect(response.stopReason, response.errorMessage).toBe("stop");
		expect(getText(response).toLowerCase()).toContain("parity");
	});

	it("round-trips a tool call", { retry: 2, timeout: 120_000 }, async () => {
		const responseStream = stream(
			copilotModel(),
			{
				messages: [user("Call the emit_token tool with payload parity.")],
				tools: [
					{
						name: "emit_token",
						description: "Emit the lowercase token requested by the user",
						parameters: {
							type: "object",
							properties: { payload: { type: "string" } },
							required: ["payload"],
						},
					},
				],
			},
			{ apiKey: apiKey!, maxTokens: 256, toolChoice: "required" },
		);
		const response = await responseStream.result();
		const toolCall = response.parts.find((part) => part.type === "toolCall");

		expect(response.stopReason, response.errorMessage).toBe("toolUse");
		expect(toolCall?.name).toBe("emit_token");
		expect(toolCall?.arguments).toEqual({ payload: "parity" });
	});
});
