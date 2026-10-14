import "./utils/env.ts";
import { createAssistantMessageEventStream, type Message } from "@codeworksh/aikit";
import { Effect } from "effect";
import fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Mcp } from "../src/mcp/mcp.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { define } from "../src/plugin/plugin.ts";
import type { LLM } from "../src/runner/llm.ts";
import { Settings } from "../src/settings/settings.ts";
import { assistant } from "./fixtures/llm.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { pendingCall } from "./tools.fixture.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp/session.mjs", import.meta.url));
const stdio = (extra: Record<string, unknown> = {}) => ({
	command: process.execPath,
	args: [fixture],
	env: { E2E_GREETING: "${MCP_E2E_GREETING}" },
	...extra,
});

/** One reply per model request, in order; an empty one ends the exchange. */
const scripted =
	(replies: ReadonlyArray<ReadonlyArray<Message.ToolCallPendingPart>>, requests: LLM.Input[]): LLM.Open =>
	(input) =>
		Effect.sync(() => {
			const index = requests.push(input);
			const calls = replies[index - 1] ?? [];
			const message = assistant(input, index, calls.length > 0 ? { stopReason: "toolUse", parts: [...calls] } : {});
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: calls.length > 0 ? "toolUse" : "stop", message });
			return stream;
		});

const write = async (file: string, value: unknown) => {
	await fs.mkdir(join(file, ".."), { recursive: true });
	await fs.writeFile(file, JSON.stringify(value, null, 2));
};

it("mcp: config layers, plugin bucket, direct tools, a crash mid-exchange and the next call reconnecting", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const project = join(dir.path, "project");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	process.env.MCP_E2E_GREETING = "hello";

	await write(join(home, "mcp.json"), {
		mcpServers: {
			e2e: stdio({ toolExposure: { secret: "hidden" } }),
			off: stdio(),
			"my-srv": stdio({ enabled: false }),
			my_srv: stdio(),
			broken: { url: "ftp://example.com/mcp" },
		},
	});
	// The project turns a user server off without restating it, and cannot add an override with no base.
	await write(join(project, ".codework", "mcp.json"), {
		mcpServers: { off: { enabled: false }, ghost: { enabled: false } },
	});

	const observed: { readonly mcpDomain: unknown[]; readonly toolDomain: string[] } = { mcpDomain: [], toolDomain: [] };
	const observer = define({
		id: "test.mcp.observer",
		kind: "mcp",
		setup: (ctx) => {
			observed.mcpDomain.push(ctx.plugin.mcp.list().map(([name, config]) => [name, config.enabled ?? true]));
			ctx.plugin.mcp.update("e2e", { description: "The E2E fixture." });
		},
	});
	const latecomer = define({
		id: "test.mcp.latecomer",
		kind: "tool",
		setup: (ctx) => {
			try {
				ctx.plugin.mcp.remove("e2e");
			} catch (error) {
				observed.toolDomain.push((error as Error).message);
			}
		},
	});

	const requests: LLM.Input[] = [];
	const llm = scripted(
		[
			[
				pendingCall("mcp__e2e__echo", { text: "hi" }, "echo"),
				pendingCall("mcp__e2e__fail", {}, "fail"),
				pendingCall("mcp__e2e__my_tool_v2", {}, "structured"),
			],
			[pendingCall("mcp__e2e__pid", {}, "pid-before"), pendingCall("mcp__e2e__crash", {}, "crash")],
			// Same exchange: the server is gone, so this call reconnects first.
			[pendingCall("mcp__e2e__pid", {}, "pid-after")],
			[],
			// Next exchange: arguments the server's schema rejects never reach it.
			[pendingCall("mcp__e2e__echo", {}, "invalid")],
			[],
		],
		requests,
	);

	const result = await Effect.gen(function* () {
		const session = yield* Session.create({
			directory: work,
			hostDir: project,
			model: { provider: "openai", id: "gpt-5.6-luna" },
		});
		yield* session.run("Use the fixture.");
		yield* session.run("Once more.");
		const path = yield* session.path();
		const messages = yield* Effect.forEach(path, ContextCodec.decodeMessage);
		const status = yield* Mcp.Service.use((mcp) => mcp.status(session.id));
		const settings = yield* Settings.Service.use((loader) => loader.load(project));
		return { messages, status, errors: settings.mcp.errors };
	}).pipe(
		Effect.provide(
			Harness.layer({
				home,
				hostCwd: dir.path,
				database: ":memory:",
				plugins: [observer, latecomer, defaultPromptPlugin],
				llm,
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

	const calls = new Map(
		result.messages
			.flatMap((message) => message.parts)
			.flatMap((part) => (part.type === "toolCall" && "result" in part ? [[part.callID, part] as const] : [])),
	);
	const outcome = (id: string) => {
		const part = calls.get(id);
		if (part === undefined) return undefined;
		return {
			status: part.status,
			isError: part.result.isError,
			content: part.result.content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)),
		};
	};

	const pidBefore = outcome("pid-before")?.content[0];
	const pidAfter = outcome("pid-after")?.content[0];
	expect(pidBefore).toMatch(/^\d+$/);
	expect(pidAfter).toMatch(/^\d+$/);
	expect(pidAfter).not.toBe(pidBefore);

	const firstTools = requests[0]?.context.tools ?? [];
	expect(firstTools.map((tool) => tool.name)).not.toContain("mcp__e2e__secret");
	// The tool set is frozen per exchange and stable across them, so every request declares the same tools.
	for (const request of requests) expect(request.context.tools).toEqual(firstTools);
	// The server's JSON Schema reaches the provider as written.
	expect(firstTools.find((tool) => tool.name === "mcp__e2e__echo")?.parameters).toEqual({
		type: "object",
		properties: { text: { type: "string", description: "What to echo." } },
		required: ["text"],
	});

	const normalise = (value: unknown) =>
		JSON.parse(
			JSON.stringify(value)
				.replaceAll(dir.path, "<tmp>")
				.replaceAll(process.execPath, "<node>")
				.replaceAll(`"${pidBefore}"`, '"<pid-before>"')
				.replaceAll(`"${pidAfter}"`, '"<pid-after>"'),
		);
	const artifact = normalise({
		requests: requests.length,
		tools: firstTools.map((tool) => tool.name),
		echoTool: firstTools.find((tool) => tool.name === "mcp__e2e__echo"),
		plugins: observed,
		calls: Object.fromEntries(
			["echo", "fail", "structured", "pid-before", "crash", "pid-after", "invalid"].map((id) => [id, outcome(id)]),
		),
		status: result.status,
		configErrors: result.errors,
	});
	await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/mcp.session.json");
}, 60_000);
