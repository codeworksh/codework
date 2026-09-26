import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_CWD, mountCwd } from "../src/sandboxes/daytona/provider.ts";

/**
 * Ungated: `mountCwd` is the one piece of Daytona's mount that decides where
 * every path resolves, and §8.1 makes a wrong answer here fail *silently* — a
 * cwd that does not exist walks up to `/`, finds no repository, and reports a
 * well-formed project rooted at nothing. The live suite can only observe the
 * branch its own credentials happen to take, so each branch is covered here.
 */
describe("EnvDaytona.mountCwd", () => {
	it("resolves a relative cwd inside the sandbox's work directory", async () => {
		expect(await mountCwd("repo", () => Promise.resolve("/home/node"))).toBe("/home/node/repo");
	});

	it("falls back to the provider default when the sandbox reports no work directory", async () => {
		expect(await mountCwd(undefined, () => Promise.resolve(undefined))).toBe(DEFAULT_CWD);
		expect(await mountCwd("repo", () => Promise.resolve(undefined))).toBe(`${DEFAULT_CWD}/repo`);
	});

	// A provider that reported a relative directory would silently root every
	// path somewhere unintended, so it is refused rather than resolved.
	it("refuses a non-absolute directory from the provider", async () => {
		await expect(mountCwd(undefined, () => Promise.resolve("home/node"))).rejects.toThrow(
			"Sandbox default cwd must be absolute",
		);
	});
});
