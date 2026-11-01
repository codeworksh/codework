import Type, { type TSchema } from "typebox";
import { describe, expect, it } from "vite-plus/test";
import * as Message from "../../src/message/message.ts";
import { complete } from "../../src/stream.ts";
import { fakeAnthropic, textReply } from "../utils/anthropic.ts";
import {
	ANTHROPIC_E2E_MODELS,
	anthropicOptions,
	describeIfAnthropic,
	getAnthropicModel,
	type StreamableModel,
} from "../utils/llm.ts";

const preferTool = (name: string, parameters: TSchema): Message.Tool => ({
	name,
	description: `Synthetic tool ${name}. Never call it.`,
	parameters,
	constrainedSampling: { type: "json_schema", strict: "prefer" },
});

// Fits either limit on its own, so it stays strict once the `prefer` tools go non-strict.
const requireTool: Message.Tool = {
	name: "required_tool",
	description: "Synthetic tool that must stay strict. Never call it.",
	parameters: Type.Object({ value: Type.String() }),
	constrainedSampling: { type: "json_schema", strict: "require" },
};

/** 21 `prefer` tools plus the `require` one: over the strict-tool count limit. */
const toolCount = [
	...Array.from({ length: 21 }, (_, index) =>
		preferTool(`count_tool_${index + 1}`, Type.Object({ value: Type.String() })),
	),
	requireTool,
];

const optionalParams = (count: number) =>
	Type.Object(
		Object.fromEntries(
			Array.from({ length: count }, (_, index) => [`field_${index + 1}`, Type.Optional(Type.String())]),
		),
	);

/** 17 optional parameters across three tools: one over the union-typed parameter limit. */
const unionCount = [
	preferTool("union_tool_1", optionalParams(6)),
	preferTool("union_tool_2", optionalParams(6)),
	preferTool("union_tool_3", optionalParams(5)),
	requireTool,
];

/** Claude's own rejections, which the recorded variant replays and the live one checks still match. */
const CASES = {
	toolCount: {
		tools: toolCount,
		message:
			"Too many strict tools (22). The maximum number of strict tools supported is 20. Try reducing the number of tools marked as strict.",
	},
	unionCount: {
		tools: unionCount,
		message:
			"Schemas contains too many parameters with union types (17 parameters with type arrays or anyOf). This causes exponential compilation cost. Reduce the number of nullable or union-typed parameters (limit: 16 parameters with unions).",
	},
} as const;

type Case = keyof typeof CASES;

/** Records each request body, then hands it to `inner`. */
function recordRequests(inner: typeof fetch) {
	const bodies: Array<{ tools?: Array<{ name: string; strict?: boolean }> }> = [];
	const record: typeof fetch = (input, init) => {
		if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
		return inner(input, init);
	};
	return { bodies, fetch: record };
}

async function run(model: StreamableModel, options: object, name: Case, fetch: typeof globalThis.fetch) {
	const requests = recordRequests(fetch);
	const message = await complete(
		model,
		{
			systemPrompt: "Reply with the single word hi. Do not call any tool.",
			messages: [
				Message.createUserMessage({
					role: "user",
					parts: [{ type: "text", text: "Say hi." }],
					time: { created: Date.now() },
				}),
			],
			tools: CASES[name].tools,
		},
		{ ...options, maxRetries: 0, factoryOptions: { fetch: requests.fetch } } as never,
	);
	expect(message.stopReason, message.errorMessage).toBe("stop");
	return {
		message,
		artifact: {
			attempts: requests.bodies.map((body) =>
				Object.fromEntries(
					(body.tools ?? [])
						.map((tool) => [tool.name, tool.strict === true] as const)
						.sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })),
				),
			),
			stopReason: message.stopReason,
			diagnostics: (message.diagnostics ?? []).map((diagnostic) => ({
				type: diagnostic.type,
				reason: diagnostic.details?.reason,
			})),
		},
	};
}

async function snapshot(artifacts: Record<Case, unknown>) {
	await expect(JSON.stringify(artifacts, null, 2)).toMatchFileSnapshot("./__artifacts__/strict-tool-limit.json");
}

describe("Strict tools over Claude's limits", () => {
	it("recorded: retries once with prefer tools non-strict", async () => {
		// A catalog Claude model: the SDK drops `strict` for model ids it does not know support it.
		const model = await getAnthropicModel(ANTHROPIC_E2E_MODELS[0]);
		const artifacts = {} as Record<Case, unknown>;
		for (const name of Object.keys(CASES) as Case[]) {
			const server = fakeAnthropic(textReply, { rejectFirst: CASES[name].message });
			const { message, artifact } = await run(model, { apiKey: "test-key" }, name, server.fetch);
			expect(message.diagnostics?.[0]?.error?.message).toBe(CASES[name].message);
			artifacts[name] = artifact;
		}
		await snapshot(artifacts);
	});

	describeIfAnthropic("Anthropic provider", () => {
		it(`live ${ANTHROPIC_E2E_MODELS[0]}: Claude rejects, then the retry succeeds`, { timeout: 120_000 }, async () => {
			const model = await getAnthropicModel(ANTHROPIC_E2E_MODELS[0]);
			const artifacts = {} as Record<Case, unknown>;
			for (const name of Object.keys(CASES) as Case[]) {
				const { message, artifact } = await run(model, anthropicOptions({ maxTokens: 256 }), name, fetch);
				expect(message.diagnostics?.[0]?.error?.message).toBe(CASES[name].message);
				artifacts[name] = artifact;
			}
			await snapshot(artifacts);
		});
	});
});
