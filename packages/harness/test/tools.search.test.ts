import fs from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import { comparableGrep, normalize, runAll, VARIANCE } from "./fixtures/search.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

/**
 * grep, find and ls on the host (real rg and fd) and on a memory sandbox
 * (just-bash's rg, no fd), over the same tree. grep and ls must answer the same on
 * both; find runs on the host and reports fd missing on memory.
 */
describe("search tools across sandboxes", () => {
	it("answer the same on the host and in memory", async () => {
		await using temp = await tmpdir();
		const root = await fs.realpath(temp.path);
		const host = normalize(
			await runAll(Sandbox.services(Sandbox.EnvNodeJSDefault.layer(), SandboxIO.host(root)), `${root}/home/bin`),
			root,
		);
		const memory = normalize(
			await runAll(
				Sandbox.EnvBash.services(
					Sandbox.EnvInMemory.layer({ cwd: "/work" }),
					SandboxIO.virtual({ driver: "memory", defaultCwd: "/work" }),
				),
				`${root}/home/bin`,
			),
			"/work",
		);

		expect(host.injected).toBe(false);
		expect(memory.injected).toBe(false);
		expect(comparableGrep(memory)).toEqual(comparableGrep(host));
		expect(memory.ls).toEqual(host.ls);
		// No fd in memory: every find call on an existing path says so, the same way.
		const { missing, ...found } = memory.find;
		expect(missing).toEqual(host.find["missing"]);
		for (const result of Object.values(found)) expect(result).toEqual(memory.find["basename"]);

		const artifact = {
			grep: { ...comparableGrep(host), [VARIANCE]: { host: host.grep[VARIANCE], memory: memory.grep[VARIANCE] } },
			ls: host.ls,
			find: { host: host.find, memory: memory.find["basename"] },
		};
		await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot(
			"./__artifacts__/tools.search.json",
		);
	}, 60_000);
});
