import "./utils/env";
import { beforeEach, afterEach, describe, expect, it } from "vite-plus/test";
import { ModelCatalog } from "../src/model/catalog";
import { Model } from "../src/model/model";
import { runCodeModeEval } from "./codemode/evals/runner";
import { liveCodeModeEvalScenarios } from "./codemode/evals/scenarios";
import { ROOT_MODELS_PATH } from "./utils/paths";

const describeIfAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

describeIfAnthropic("Agent CodeMode evals", () => {
	const originalModelsPath = process.env.CODEWORK_AIKIT_MODELS_PATH;

	beforeEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = ROOT_MODELS_PATH;
		ModelCatalog.modelsDevData.reset();
		Model.registry.reset();
	});

	afterEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = originalModelsPath;
		ModelCatalog.modelsDevData.reset();
		Model.registry.reset();
	});

	for (const scenario of liveCodeModeEvalScenarios) {
		it(
			`passes live eval: ${scenario.name}`,
			async () => {
				const report = await runCodeModeEval<Record<string, unknown>>(scenario);

				expect(report.sandboxCallCount).toBe(1);
				expect(report.successfulSandboxCall).toBe(true);
				expect(report.finalJson).toEqual(scenario.expected);
				expect(report.sandboxResult).toEqual(scenario.expected);
				expect(report.finalMatchesSandbox).toBe(true);
				expect(report.finalMatchesExpected).toBe(true);

				for (const snippet of scenario.expectedCodeSnippets ?? []) {
					expect(report.generatedCode).toContain(snippet);
				}
			},
			scenario.timeoutMs ?? 60_000,
		);
	}
});
