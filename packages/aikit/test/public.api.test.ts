import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ROOT_MODELS_PATH } from "./utils/paths.ts";

const importFetch = globalThis.fetch;
globalThis.fetch = (async () =>
	({
		ok: false,
		text: async () => "",
	}) as Response) as unknown as typeof fetch;
const aikit = await import("../src/index.ts");
const { Agent } = await import("../src/agent/agent.ts");
const { Loop } = await import("../src/agent/loop.ts");
const { Stream } = await import("../src/provider/stream.ts");
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
		expect(Object.keys(aikit).sort()).toEqual(["Agent", "Message", "agent", "llm", "stream"]);

		expect(aikit.Agent).toBe(Agent);
		expect(aikit.llm).toBeDefined();
		expect(aikit.stream).toBeDefined();
		expect(aikit.agent).toBeDefined();
		expect(aikit.Message).toBeDefined();

		expect(aikit.stream.resolveProtocolProvider).toBe(Stream.resolveProtocolProvider);

		expect(aikit.agent.loop).toBe(Loop.run);
		expect(aikit.agent.loopContinue).toBe(Loop.runContinue);
		expect(aikit.stream.complete).toBeDefined();
		expect(aikit.stream.simple).toBeDefined();
		expect(aikit.stream.completeSimple).toBeDefined();
	});
});
