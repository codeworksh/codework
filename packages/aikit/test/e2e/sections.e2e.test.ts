import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { llm } from "../../src/llm.ts";
import * as Message from "../../src/message/message.ts";
import {
	getGitHubCopilotApiKey,
	GitHubCopilotOAuthClient,
	gitHubCopilotBaseUrl,
} from "../../src/oauth/github/copilot.ts";
import { complete } from "../../src/stream.ts";
import {
	ANTHROPIC_E2E_MODELS,
	anthropicOptions,
	describeIfAnthropic,
	describeIfGoogle,
	describeIfOpenAI,
	describeIfOpenAICodex,
	describeIfOpenRouter,
	getAnthropicModel,
	getGoogleModel,
	getOpenAICodexModel,
	getOpenAIModel,
	getOpenRouterModel,
	googleOptions,
	openaiCodexOptions,
	openaiOptions,
	openrouterOptions,
	type StreamableModel,
} from "../utils/llm.ts";

const copilotApiKey = await getGitHubCopilotApiKey();
const copilotBaseUrl = gitHubCopilotBaseUrl((await new GitHubCopilotOAuthClient().getCredentials()) ?? undefined);
const describeIfGitHubCopilot = copilotApiKey ? describe : describe.skip;

async function getCopilotModel(modelId: string): Promise<StreamableModel> {
	const model = await llm("github-copilot", modelId);
	if (!model) throw new Error(`expected github-copilot model ${modelId}`);
	return model as StreamableModel;
}

/** Records each request body the provider sends (Codex zstd-compresses its own), then forwards it. */
function recordRequests() {
	const bodies: Array<Record<string, unknown>> = [];
	const record: typeof fetch = (input, init) => {
		const body = init?.body;
		if (typeof body === "string") bodies.push(JSON.parse(body));
		else if (body instanceof Uint8Array) bodies.push(JSON.parse(zstdDecompressSync(body).toString()));
		return fetch(input, init);
	};
	return { bodies, fetch: record };
}

const codeword = (word: string) =>
	Message.createSystemMessage({ sections: { codeword: `<codeword>${word}</codeword>` } });

const ask = (text: string) =>
	Message.createUserMessage({ role: "user", parts: [{ type: "text", text }], time: { created: Date.now() } });

const answer = (message: Message.AssistantMessage) =>
	message.parts
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("")
		.trim()
		.toLowerCase();

/*
 * A prompt section changed mid-conversation reaches the model on the next request. The first
 * turn has the codeword "alpha"; a system message then replaces the section with "bravo", and
 * the second turn must answer "bravo". The artifact records whether the change went in place
 * (the earlier prompt still sent) or was folded into the leading prompt.
 */
async function answerChangedSection(model: StreamableModel, options: object, name: string) {
	const context: Message.Context = {
		systemPrompt: "Answer with the codeword from the codeword section when asked. Reply with the codeword only.",
		messages: [codeword("alpha"), ask("What is the codeword?")],
	};

	const first = await complete(model, context, options as never);
	expect(first.stopReason, first.errorMessage).toBe("stop");
	expect(answer(first)).toContain("alpha");
	context.messages.push(first, codeword("bravo"), ask("What is the codeword now?"));

	const requests = recordRequests();
	const second = await complete(model, context, {
		...options,
		factoryOptions: { ...(options as { factoryOptions?: object }).factoryOptions, fetch: requests.fetch },
	} as never);
	expect(second.stopReason, second.errorMessage).toBe("stop");
	expect(answer(second)).toContain("bravo");

	const body = JSON.stringify(requests.bodies.at(-1));
	const artifact = {
		promptChange: body.includes('Updated system prompt section \\"codeword\\"') ? "in place" : "folded",
		earlierSectionSent: body.includes("<codeword>alpha</codeword>"),
		answer: "bravo",
	};
	await expect(JSON.stringify(artifact, null, "\t")).toMatchFileSnapshot(`./__artifacts__/sections.${name}.json`);
	return artifact;
}

describe("Prompt sections changed mid-conversation", () => {
	describeIfOpenAICodex("OpenAI Codex provider", () => {
		it("gpt-6-luna sends the change in place", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getOpenAICodexModel("gpt-6-luna");
			const artifact = await answerChangedSection(model, openaiCodexOptions(), "openai-codex");
			expect(artifact.promptChange).toBe("in place");
		});
	});

	describeIfAnthropic("Anthropic provider", () => {
		it(ANTHROPIC_E2E_MODELS[0], { retry: 2, timeout: 120_000 }, async () => {
			const model = await getAnthropicModel(ANTHROPIC_E2E_MODELS[0]);
			const artifact = await answerChangedSection(model, anthropicOptions({ maxTokens: 512 }), "anthropic");
			expect(artifact.promptChange).toBe("folded");
		});
	});

	describeIfOpenAI("OpenAI provider", () => {
		it("gpt-6-luna", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getOpenAIModel("gpt-6-luna");
			const artifact = await answerChangedSection(model, openaiOptions(), "openai");
			expect(artifact.promptChange).toBe("folded");
		});
	});

	describeIfGoogle("Google provider", () => {
		it("gemini-3.5-flash", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getGoogleModel();
			const artifact = await answerChangedSection(model, googleOptions(), "google");
			expect(artifact.promptChange).toBe("folded");
		});
	});

	describeIfGitHubCopilot("GitHub Copilot provider", () => {
		it("gpt-6-luna sends the change in place on /responses", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getCopilotModel("gpt-6-luna");
			const artifact = await answerChangedSection(
				model,
				{ apiKey: copilotApiKey!, baseURL: copilotBaseUrl, reasoning: "low" },
				"github-copilot-responses",
			);
			expect(artifact.promptChange).toBe("in place");
		});
	});

	describeIfOpenRouter("OpenRouter provider", () => {
		it("deepseek/deepseek-v4.1-flash", { retry: 2, timeout: 120_000 }, async () => {
			const model = await getOpenRouterModel("deepseek/deepseek-v4.1-flash");
			const artifact = await answerChangedSection(model, openrouterOptions(), "openrouter");
			expect(artifact.promptChange).toBe("folded");
		});
	});
});
