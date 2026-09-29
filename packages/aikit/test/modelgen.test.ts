import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Value from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { githubCopilotApiMethod, githubCopilotBuiltInModels, openAICodexBuiltInModels } from "../src/cli/modelgen.ts";
import * as Model from "../src/model/model.ts";
import * as ModelCatalog from "../src/model/catalog.ts";
import * as Thinking from "../src/llm/thinking.ts";
import { generateModels } from "../src/modelgen.ts";

function copilotModelsDevProvider(): Parameters<typeof githubCopilotBuiltInModels>[0] {
	const base = {
		family: "test",
		attachment: true,
		tool_call: true,
		temperature: true,
		release_date: "2026-01-01",
		last_updated: "2026-01-01",
		modalities: { input: ["text", "image"], output: ["text"] },
		open_weights: false,
		cost: { input: 1, output: 4 },
		limit: { context: 400_000, output: 128_000 },
	};
	return {
		id: "github-copilot",
		name: "GitHub Copilot",
		env: ["GITHUB_TOKEN"],
		npm: "@ai-sdk/openai-compatible",
		api: "https://api.githubcopilot.com",
		models: {
			"claude-opus-4.8": {
				...base,
				id: "claude-opus-4.8",
				name: "Claude Opus 4.8",
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
			},
			"gpt-5.4": {
				...base,
				id: "gpt-5.4",
				name: "GPT-5.4",
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
			},
			"gemini-3.6-flash": {
				...base,
				id: "gemini-3.6-flash",
				name: "Gemini 3.6 Flash",
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
			},
			"gpt-5-chat-latest": {
				...base,
				id: "gpt-5-chat-latest",
				name: "GPT-5 Chat Latest",
				reasoning: false,
			},
			deprecated: {
				...base,
				id: "gpt-4o",
				name: "GPT-4o",
				reasoning: false,
				status: "deprecated",
			},
		},
	};
}

describe("generateModels", () => {
	it("generates supported provider models and merges explicit Codex models", async () => {
		const directory = await mkdtemp(join(tmpdir(), "aikit-modelgen-"));
		const modelsDevPath = join(directory, "modelsdev.json");
		const outputPath = join(directory, "models.gen.json");
		const configuredModelsDevPath = process.env.OPENCODE_MODELS_DEV_FILE;
		const supportedModel = {
			id: "claude-test",
			name: "Claude Test",
			family: "claude",
			attachment: true,
			reasoning: true,
			tool_call: true,
			temperature: true,
			release_date: "2026-01-01",
			last_updated: "2026-01-01",
			modalities: { input: ["text", "image", "audio"], output: ["text"] },
			open_weights: false,
			cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
			limit: { context: 200_000, output: 8_192 },
		};
		const googleIds = [
			"gemini-3.5-flash",
			"gemini-3.5-flash-lite",
			"gemini-3.7-flash",
			"gemini-3.8-flash",
			"gemini-3.1-pro-preview",
		];
		const googleProviders = Object.fromEntries(
			["google", "google-vertex"].map((id) => [
				id,
				{
					id,
					name: id,
					env: [],
					npm: `@ai-sdk/${id}`,
					models: Object.fromEntries(
						googleIds.map((modelId) => [modelId, { ...supportedModel, id: modelId, name: modelId }]),
					),
				},
			]),
		);

		try {
			await writeFile(
				modelsDevPath,
				JSON.stringify({
					...googleProviders,
					anthropic: {
						id: "anthropic",
						name: "Anthropic",
						env: ["ANTHROPIC_API_KEY"],
						npm: "@ai-sdk/anthropic",
						api: "https://api.anthropic.com/v1",
						models: {
							"claude-test": supportedModel,
							"claude-without-tools": {
								...supportedModel,
								id: "claude-without-tools",
								name: "Claude Without Tools",
								tool_call: false,
							},
						},
					},
				}),
			);
			process.env.OPENCODE_MODELS_DEV_FILE = modelsDevPath;

			await expect(generateModels({ path: outputPath })).resolves.toBe(outputPath);
			const catalog = (await ModelCatalog.load(outputPath)) as Model.BuiltInModels;
			const model = catalog.anthropic?.["claude-test"];

			expect(Value.Check(Model.Info, model)).toBe(true);
			expect(model).toMatchObject({
				id: "claude-test",
				provider: { id: "anthropic", source: "api", env: ["ANTHROPIC_API_KEY"] },
				baseUrl: "https://api.anthropic.com/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 8_192,
				api: { id: "claude-test", method: "languageModel" },
				providerOptionsKey: "anthropic",
				protocol: "anthropic",
			});
			expect(catalog.anthropic?.["claude-without-tools"]).toBeUndefined();
			expect(Object.keys(catalog["openai-codex"] ?? {})).toEqual(Object.keys(openAICodexBuiltInModels()));
			for (const provider of ["google", "google-vertex"]) {
				for (const id of googleIds) {
					const generated = catalog[provider]?.[id];
					expect(Value.Check(Model.Info, generated)).toBe(true);
					if (!generated) throw new Error(`Missing generated model ${provider}/${id}`);
					const restricted = !id.startsWith("gemini-3.5");
					if (restricted) {
						expect(generated.thinkingLevelMap).toEqual({ off: "low", minimal: null });
						expect(Model.getSupportedThinkingLevels(generated)).toEqual(["off", "low", "medium", "high"]);
					} else {
						expect(generated.thinkingLevelMap).toBeUndefined();
						expect(Model.getSupportedThinkingLevels(generated)).toContain("minimal");
					}
					const off = Thinking.resolvePlan(generated, { messages: [] }, {});
					const minimal = Thinking.resolvePlan(generated, { messages: [] }, { reasoning: "minimal" });
					expect(Thinking.reasoningProviderOptions(generated, off)[provider]?.thinkingConfig).toEqual({
						thinkingLevel: restricted ? "low" : "minimal",
					});
					expect(Thinking.reasoningProviderOptions(generated, minimal)[provider]?.thinkingConfig).toEqual({
						thinkingLevel: restricted ? "low" : "minimal",
						includeThoughts: true,
					});
				}
			}
		} finally {
			if (configuredModelsDevPath === undefined) delete process.env.OPENCODE_MODELS_DEV_FILE;
			else process.env.OPENCODE_MODELS_DEV_FILE = configuredModelsDevPath;
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("generateModels refetch", () => {
	it("reads models.dev again on every call, for a process that regenerates", async () => {
		const directory = await mkdtemp(join(tmpdir(), "aikit-modelgen-"));
		const modelsDevPath = join(directory, "modelsdev.json");
		const outputPath = join(directory, "models.gen.json");
		const configuredModelsDevPath = process.env.OPENCODE_MODELS_DEV_FILE;
		const provider = (id: string) => ({
			id,
			name: id,
			env: [],
			npm: "@ai-sdk/anthropic",
			models: {
				"claude-test": {
					id: "claude-test",
					name: "Claude Test",
					family: "claude",
					attachment: true,
					tool_call: true,
					release_date: "2026-01-01",
					last_updated: "2026-01-01",
					modalities: { input: ["text"], output: ["text"] },
					open_weights: false,
				},
			},
		});
		try {
			process.env.OPENCODE_MODELS_DEV_FILE = modelsDevPath;
			await writeFile(modelsDevPath, JSON.stringify({ first: provider("first") }));
			await generateModels({ path: outputPath });
			expect(Object.keys(await ModelCatalog.load(outputPath))).toContain("first");

			await writeFile(modelsDevPath, JSON.stringify({ second: provider("second") }));
			await generateModels({ path: outputPath });
			const catalog = await ModelCatalog.load(outputPath);
			expect(Object.keys(catalog)).toContain("second");
			expect(Object.keys(catalog)).not.toContain("first");
		} finally {
			if (configuredModelsDevPath === undefined) delete process.env.OPENCODE_MODELS_DEV_FILE;
			else process.env.OPENCODE_MODELS_DEV_FILE = configuredModelsDevPath;
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("githubCopilotApiMethod", () => {
	it("routes Claude 4.x/5.x to Anthropic Messages", () => {
		for (const id of [
			"claude-haiku-4.5",
			"claude-sonnet-4.6",
			"claude-opus-4.8",
			"claude-opus-5",
			"claude-fable-5",
		]) {
			expect(githubCopilotApiMethod(id)).toBe(Model.APIMethodEnum.messages);
		}
	});

	it("routes GPT-5+, Grok, OSWE, and MAI to Responses", () => {
		for (const id of [
			"gpt-5.4",
			"gpt-5-mini",
			"gpt-6-astra",
			"grok-4.6",
			"oswe-vscode-prime",
			"mai-code-1.1-flash",
		]) {
			expect(githubCopilotApiMethod(id)).toBe(Model.APIMethodEnum.responses);
		}
	});
});

describe("githubCopilotBuiltInModels", () => {
	it("rewrites the models.dev provider onto the bundled Copilot provider", () => {
		const models = githubCopilotBuiltInModels(copilotModelsDevProvider());
		for (const model of Object.values(models)) {
			expect(Value.Check(Model.Info, model)).toBe(true);
			expect(model.protocol).toBe(Model.KnownProviderEnum.githubCopilot);
			expect(model.provider.id).toBe("github-copilot");
			expect(model.provider.env).toEqual(["COPILOT_GITHUB_TOKEN"]);
			expect(model.npm).toBe("@codeworksh/ai-sdk-github-copilot");
			expect(model.baseUrl).toBe("https://api.githubcopilot.com");
			expect(model.api?.url).toBe("https://api.githubcopilot.com");
			expect(model.providerOptionsKey).toBe("github-copilot");
			expect(model.headers?.["Copilot-Integration-Id"]).toBe("vscode-chat");
		}
	});

	it("marks adaptive Claude and stores reasoning options for Responses models", () => {
		const models = githubCopilotBuiltInModels(copilotModelsDevProvider());
		const claude = models["claude-opus-4.8"]!;
		expect(claude.compat?.forceAdaptiveThinking).toBe(true);
		expect(claude.thinkingLevelMap).toMatchObject({ minimal: "low", xhigh: "xhigh", max: "max" });

		const gpt = models["gpt-5.4"]!;
		expect(gpt.providerOptions?.["github-copilot"]).toEqual({
			store: false,
			include: ["reasoning.encrypted_content"],
		});
		expect(gpt.compat?.supportsOpenAIGrammarTools).toBe(true);
		expect(gpt.thinkingLevelMap).toMatchObject({ off: null, minimal: "low", xhigh: "xhigh", max: null });
	});
});
