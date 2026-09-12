import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ContextCodec } from "../../src/context/codec.ts";
import { Harness } from "../../src/effect/harness.ts";
import { Sandbox } from "../../src/effect/sandbox.ts";
import { Session } from "../../src/effect/session.ts";
import type { SandboxDriver } from "../../src/sandbox/driver.ts";
import { pendingCall } from "../tools.fixture.ts";
import { toolTurn } from "./llm.ts";
import { remoteSuite } from "./live.ts";
import { withSettings } from "./settings.ts";

/** Every call goes through plugin setup, the runner, the mounted driver and durable settlement. */
export const bashPluginSpec = (options: {
	readonly driver: SandboxDriver.Registration;
	readonly resourceId: () => Promise<string>;
	readonly streaming: boolean;
}) => {
	const exchange = (input: { root: string; custom: string }, command: string, live = false, timeout?: number) =>
		Effect.gen(function* () {
			const sandbox = yield* Sandbox.register({
				driver: options.driver.registered.name,
				providerResourceId: yield* Effect.promise(options.resourceId),
			});
			const session = yield* Session.create({
				sandbox,
				directory: "/tmp",
				model: { provider: "openai", id: "gpt-5.6-luna" },
			});
			yield* session.run(`Use bash exactly once to execute this command: ${command}\nReport its output verbatim.`);
			const path = yield* session.path();
			const messages = yield* Effect.forEach(path, ContextCodec.decodeMessage);
			expect(path.every((entry) => entry.entry.state === "committed")).toBe(true);
			const calls = messages.flatMap((message) => message.parts.filter((part) => part.type === "toolCall"));
			expect(calls).toHaveLength(1);
			const call = calls[0];
			if (call === undefined || call.type !== "toolCall" || (call.status !== "completed" && call.status !== "error"))
				throw new Error("bash was not settled");
			expect(call.name).toBe("bash");
			return { call, messages };
		}).pipe(
			Effect.provide(
				Harness.layer({
					home: join(input.root, "home"),
					userConfigDir: input.custom,
					database: ":memory:",
					sandboxes: [options.driver],
					plugins: ["codework.tool.bash", "codework.prompt.default"],
					...(live
						? {}
						: { llm: toolTurn(pendingCall("bash", { command, ...(timeout === undefined ? {} : { timeout }) })) }),
				}),
			),
			Effect.timeout("120 seconds"),
			Effect.scoped,
			Effect.runPromise,
		);

	describe("bash plugin through the complete harness", () => {
		it(
			"uses the session's remote cwd and persists the Bash failure shape",
			() =>
				withSettings(async (input) => {
					const { call } = await exchange(input, "pwd; printf 'failure-output\\n'; exit 7");
					expect(call.status).toBe("error");
					expect(call.result).toMatchObject({
						isError: true,
						details: { _tag: "BashFailed", exitCode: 7, output: "/tmp\nfailure-output\n", truncated: false },
					});
				}),
			180_000,
		);

		it(
			"truncates real output and preserves the entire spill file",
			() =>
				withSettings(async (input) => {
					const { call } = await exchange(input, "seq 1 2500");
					expect(call.status).toBe("completed");
					const details = call.result.details as { truncated: boolean; fullOutputPath?: string; output: string };
					expect(details.truncated).toBe(true);
					if (details.fullOutputPath === undefined) throw new Error("missing full output path");
					try {
						expect(await readFile(details.fullOutputPath, "utf8")).toBe(
							Array.from({ length: 2500 }, (_, index) => `${index + 1}\n`).join(""),
						);
						expect(details.output).toContain("2500\n");
						expect(details.output).not.toMatch(/^1\n/);
					} finally {
						await rm(details.fullOutputPath, { force: true });
					}
				}),
			180_000,
		);

		it(
			"settles a real deadline with the backend's partial-output contract",
			() =>
				withSettings(async (input) => {
					const { call } = await exchange(input, "printf 'partial-output\\n'; sleep 20", false, 5);
					expect(call.status).toBe("error");
					expect(call.result).toMatchObject({
						isError: true,
						details: {
							_tag: "BashTimedOut",
							timeoutSeconds: 5,
							truncated: false,
							output: options.streaming ? "partial-output\n" : "",
						},
					});
				}),
			180_000,
		);

		remoteSuite("OPENAI_API_KEY", Boolean(process.env.OPENAI_API_KEY?.trim()))(
			"live model and real Bash plugin",
			() => {
				it(
					"executes a tool call and continues with its persisted result",
					() =>
						withSettings(async (input) => {
							const marker = `bash-plugin-${randomUUID()}`;
							const { call, messages } = await exchange(input, `printf '${marker}'`, true);
							expect(call.status).toBe("completed");
							expect(call.result).toMatchObject({ isError: false, details: { output: marker, exitCode: 0 } });
							const final = messages.at(-1);
							expect(final?.role).toBe("assistant");
							expect(
								final?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
							).toContain(marker);
						}),
					180_000,
				);
			},
		);
	});
};
