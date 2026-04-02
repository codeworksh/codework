import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ROOT_MODELS_PATH } from "./utils/paths.ts";

const importFetch = globalThis.fetch;
globalThis.fetch = (async () =>
	({
		ok: false,
		text: async () => "",
	}) as Response) as unknown as typeof fetch;
const aikit = await import("../src/index.ts");
const { Loop } = await import("../src/agent/loop.ts");
const { Stream } = await import("../src/provider/stream.ts");
const { validateToolArguments, validateToolCall } = await import("../src/utils/validation.ts");
globalThis.fetch = importFetch;

describe("public api", () => {
	const originalModelsPath = process.env.CODEWORK_AIKIT_MODELS_PATH;

	beforeEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = ROOT_MODELS_PATH;
	});

	afterEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = originalModelsPath;
	});

	it("exports the facade entrypoints from the package root", () => {
		expect(aikit.llm).toBeDefined();
		expect(aikit.stream).toBeDefined();
		expect(aikit.agent).toBeDefined();

		expect(aikit.stream.complete).toBe(aikit.complete);
		expect(aikit.stream.simple).toBe(aikit.streamSimple);
		expect(aikit.stream.completeSimple).toBe(aikit.completeSimple);
		expect(aikit.stream.resolveProtocolProvider).toBe(Stream.resolveProtocolProvider);

		expect(aikit.agent.loop).toBe(Loop.agentLoop);
		expect(aikit.agent.continue).toBe(Loop.agentLoopContinue);
	});

	it("exports the core namespaces and validation helpers", () => {
		expect(aikit.Agent).toBeDefined();
		expect(aikit.Event).toBeDefined();
		expect(aikit.Message).toBeDefined();
		expect(aikit.Model).toBeDefined();
		expect(aikit.Stream).toBe(Stream);
		expect(aikit.validateToolArguments).toBe(validateToolArguments);
		expect(aikit.validateToolCall).toBe(validateToolCall);
	});
});
