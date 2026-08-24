import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

const run = (...args: ReadonlyArray<string>) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

describe("codework CLI", () => {
	it("documents local as the default and exposes remote sandbox flags", () => {
		const result = run("run", "--help");

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("--sandbox choice");
		expect(result.stdout).toContain("default: local");
		expect(result.stdout).toContain("choices: local, daytona, vercel");
		expect(result.stdout).toContain("--sandbox-provider-id string");
	});

	it("requires a provider sandbox ID to name its driver", () => {
		const result = run("run", "--sandbox-provider-id", "existing-id", "test");

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("--sandbox-provider-id requires a remote --sandbox");
	});
});
