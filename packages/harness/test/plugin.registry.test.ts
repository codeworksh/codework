import { Effect } from "effect";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parse, type Fetchable } from "../src/plugin/source.ts";
import { add } from "../src/plugin/store.ts";
import { NAME, npmrc, withRegistry } from "./fixtures/registry.ts";

/*
 * The npm toolchain against a real registry on this machine.
 *
 * `plugin.npm.live.test.ts` proves arborist and pacote behave as assumed against the public
 * registry. This file proves what a passing install cannot show: that no audit is ever requested,
 * and that a lifecycle script never runs -- each of which only shows up much later, as a stall or
 * a security failure.
 */

const withDirectory = async (body: (directory: string) => Promise<void>) => {
	const directory = await mkdtemp(join(tmpdir(), "plugin-registry-"));
	try {
		await body(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};

const fetchable = (spec: string) => Effect.runSync(parse(spec, "/unused")) as Fetchable;
const accept = () => Effect.succeed("ok" as const);

describe("an install against a private registry", () => {
	it("asks for no audit report", () =>
		withDirectory(async (directory) =>
			withRegistry(join(directory, "packages"), async (registry) => {
				const host = join(directory, "project");
				// `audit=true` in the person's own config, to prove ours is the one that decides.
				await npmrc(host, registry, "audit=true\n");

				await Effect.runPromise(
					add(fetchable(`${NAME}@1.0.0`), join(directory, "cache"), { from: host, validate: accept }),
				);

				// Arborist waits on a report we never read, so we turn it off. A registry that is
				// slow to answer would otherwise hold up every install for nothing.
				expect(registry.audits()).toBe(0);
			}),
		));

	it("runs no lifecycle script, whatever the project's own .npmrc asks for", () =>
		withDirectory(async (directory) => {
			const marker = join(directory, "postinstall-ran");
			await withRegistry(
				join(directory, "packages"),
				async (registry) => {
					const host = join(directory, "project");
					/*
					 * Both of npm's own gates, turned off by the repository itself -- which it
					 * may do, in a file we now genuinely read (§15 Q2). npm 12 added a second
					 * one (`allow-scripts`, npm/rfcs#868) that blocks an unreviewed package even
					 * when `ignore-scripts` is false, and `dangerously-allow-all-scripts` is the
					 * documented way past it. With both off, ours is the only gate left, which is
					 * the point: a test that leans on npm's defaults passes whether we set
					 * `ignoreScripts` or not.
					 */
					await npmrc(host, registry, "ignore-scripts=false\ndangerously-allow-all-scripts=true\n");

					await Effect.runPromise(
						add(fetchable(`${NAME}@1.0.0`), join(directory, "cache"), { from: host, validate: accept }),
					);

					/*
					 * A lifecycle script runs at *install* time -- before anyone has decided to
					 * trust this code, and before the module is even imported. `ignoreScripts` is
					 * set on the Arborist constructor, which is the only place arborist reads it
					 * from (`rebuild.js` checks `this.options`), so neither a per-call option nor
					 * a config file can put it back.
					 */
					expect(existsSync(marker)).toBe(false);
				},
				{ scripts: { postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` } },
			);
		}));
});
