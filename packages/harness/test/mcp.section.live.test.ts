import type { Message } from "@codeworksh/aikit";
import { Effect } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Mcp } from "../src/mcp/mcp.ts";
import { builtins } from "../src/plugin/builtin.ts";
import { LLM } from "../src/runner/llm.ts";
import { sectionNames } from "./fixtures/llm.ts";
import { stdio, waitFor, write } from "./fixtures/mcp/turns.ts";
import { withSettings } from "./fixtures/settings.ts";
import { available, LIVE } from "./utils/live.ts";

/**
 * A real model reads the `mcpservers` section. A deferred server is listed with its configured
 * description; once that is dropped, its summary is the first line of the instructions it sent on
 * connecting, and the next prompt carries only that section, after the prompt it came with.
 */

const live = LIVE.find((one) => one.name === "openai-codex")!;
const MODEL = "gpt-6-luna";
const ask = (topic: string) =>
	`Which MCP server would you load tools from with toolsearch for ${topic}? Answer from your instructions, ` +
	"without calling any tool. Reply with only its namespace, or `none`.";

it.skipIf(!available(live))(
	"mcp: the mcpservers section lists a deferred server, and a changed summary is sent alone",
	{
		timeout: 300_000,
	},
	() =>
		withSettings(async ({ root, custom }) => {
			await writeFile(
				join(custom, "settings.jsonc"),
				JSON.stringify({ model: { provider: live.provider, id: MODEL } }),
			);
			const home = join(root, "home");
			const server = (description?: string) =>
				write(join(custom, "mcp.json"), {
					mcpServers: {
						atlas: stdio(
							{ exposure: "deferred", ...(description === undefined ? {} : { description }) },
							{ E2E_INSTRUCTIONS: "Tide tables for coastal towns.\nCall the echo tool to test." },
						),
					},
				});
			await server("Capital cities of the world.");

			const sent: Message.Context[] = [];
			const llm: LLM.Open = (input, signal) => {
				sent.push(input.context);
				return LLM.open(input, signal);
			};

			const replies = await Effect.gen(function* () {
				const handle = yield* Session.create({ directory: root });
				yield* handle.main.run(ask("capital cities"));
				yield* handle.main.wait();
				// Same connection: description is not part of what an instance is started from.
				yield* Effect.promise(() => server());
				const mcp = yield* Mcp.Service;
				yield* waitFor(mcp.status(handle.main.id), (all) => all.some((one) => one.state === "connected"));
				yield* handle.main.run(ask("tide tables"));
				yield* handle.main.wait();
				const messages = yield* Effect.forEach(yield* handle.main.history(), ContextCodec.decodeMessage);
				return messages.flatMap((message) =>
					message.role === "assistant"
						? [
								ContextCodec.parts(message)
									.flatMap((part) => (part.type === "text" ? [part.text] : []))
									.join("")
									.trim(),
							]
						: [],
				);
			}).pipe(
				Effect.provide(
					Harness.layer({
						home,
						hostCwd: root,
						database: ":memory:",
						userConfigDir: custom,
						plugins: builtins,
						llm,
					}),
				),
				Effect.scoped,
				Effect.timeout("240 seconds"),
				Effect.runPromise,
			);

			const last = sent.at(-1)!;
			const declared = last.messages.flatMap((message) =>
				message.role === "system"
					? [{ sections: sectionNames(message.sections), mcpservers: message.sections?.mcpservers }]
					: [],
			);
			const order = last.messages.map((message) => message.role);
			const artifact = {
				declared,
				// The change follows the second prompt: everything before it is the first request's prefix.
				order,
				// The model reads the change: tide tables come only from the second declaration.
				answer: replies.at(-1)?.replace(/`/g, ""),
			};
			expect(declared).toHaveLength(2);
			expect(declared[1]?.sections).toEqual(["mcpservers"]);
			expect(replies).toHaveLength(2);
			expect(artifact.answer).toBe("mcp__atlas");
			await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot(
				`./__artifacts__/mcp.section.live.${live.name}.json`,
			);
		}),
);
