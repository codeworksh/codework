import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ContextCodec } from "../../src/context/codec.ts";
import { Harness } from "../../src/effect/harness.ts";
import { Sandbox } from "../../src/effect/sandbox.ts";
import { Session } from "../../src/effect/session.ts";
import { SandboxController } from "../../src/sandbox/control.ts";
import type { SandboxDriver } from "../../src/sandbox/driver.ts";
import { SandboxIO } from "../../src/sandbox/io.ts";
import { bashPlugin } from "../../src/plugin/builtin/tool/bash.ts";
import { defaultPromptPlugin } from "../../src/plugin/builtin/prompt/default.ts";
import { pendingCall } from "../tools.fixture.ts";
import { toolTurn } from "./llm.ts";
import { remoteSuite } from "./live.ts";
import { withSettings } from "./settings.ts";

const SETTLE = "3 seconds";

/** Every call goes through plugin setup, the runner, the mounted driver and durable settlement. */
export const bashPluginSpec = (options: {
	readonly driver: SandboxDriver.Registration;
	readonly resourceId: () => Promise<string>;
	readonly streaming: boolean;
}) => {
	const exchange = (
		input: { root: string; custom: string },
		command: string,
		live = false,
		timeout?: number,
		/** A file the command keeps writing: read twice, {@link SETTLE} apart, once the call is settled. */
		witness?: string,
	) =>
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
			// The output file lives in the sandbox, so it is read through a mount of it.
			const saved = (call.result.details as { fullOutputPath?: string }).fullOutputPath;
			const controller = yield* SandboxController.Controller;
			const spilled =
				saved === undefined
					? undefined
					: yield* controller.withMount(
							sandbox.id,
							Effect.flatMap(SandboxIO.FileSystem, (fs) =>
								fs.readFile(saved).pipe(Effect.tap(() => fs.rm(saved, { force: true }))),
							),
						);
			const witnessed =
				witness === undefined
					? undefined
					: yield* controller.withMount(
							sandbox.id,
							Effect.gen(function* () {
								const fs = yield* SandboxIO.FileSystem;
								yield* Effect.sleep(SETTLE);
								const settled = yield* fs.readFile(witness);
								yield* Effect.sleep(SETTLE);
								return { settled, later: yield* fs.readFile(witness) };
							}),
						);
			return { call, messages, spilled, witnessed };
		}).pipe(
			Effect.provide(
				Harness.layer({
					home: join(input.root, "home"),
					hostCwd: input.root,
					userConfigDir: input.custom,
					database: ":memory:",
					sandboxes: [options.driver],
					plugins: [bashPlugin, defaultPromptPlugin],
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
					const { call, spilled } = await exchange(input, "seq 1 2500");
					expect(call.status).toBe("completed");
					const details = call.result.details as { truncated: boolean; fullOutputPath?: string; output: string };
					expect(details.truncated).toBe(true);
					expect(spilled).toBe(Array.from({ length: 2500 }, (_, index) => `${index + 1}\n`).join(""));
					expect(details.output).toContain("2500\n");
					expect(details.output).not.toMatch(/^1\n/);
				}),
			180_000,
		);

		it(
			"keeps output that decodes larger than it is, and numbers its lines as the sandbox counts them",
			() =>
				withSettings(async (input) => {
					const { call, spilled } = await exchange(
						input,
						`awk 'BEGIN { for (i = 0; i < 2500; i++) printf "\\377\\n" }'`,
					);
					expect(call.status).toBe("completed");
					const details = call.result.details as { truncated: boolean; fullOutputPath?: string; output: string };
					expect(details.truncated).toBe(true);
					expect(spilled).toHaveLength(5000);
					expect(
						details.output.endsWith(`[showing lines 501-2500 of 2500. Full output: ${details.fullOutputPath}]`),
					).toBe(true);
				}),
			180_000,
		);

		it(
			"stops the command at the deadline",
			() =>
				withSettings(async (input) => {
					const witness = `/tmp/heartbeat-${randomUUID()}`;
					const { call, witnessed } = await exchange(
						input,
						`while :; do echo tick >> ${witness}; sleep 0.2; done`,
						false,
						3,
						witness,
					);
					expect(call.status).toBe("error");
					expect(call.result.details).toMatchObject({ _tag: "BashTimedOut", timeoutSeconds: 3 });
					expect(witnessed?.settled.length).toBeGreaterThan(0);
					expect(witnessed?.later).toBe(witnessed?.settled);
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
