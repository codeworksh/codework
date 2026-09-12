import dedent from "dedent";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const harness = resolve(root, "packages/harness");
const external = resolve(root, "extras/codework-sandbox-vercel");
const envFile = resolve(harness, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const temporary = await mkdtemp(resolve(tmpdir(), "codework-sandbox-package-"));
const artifacts = resolve(temporary, "artifacts");
const consumer = resolve(temporary, "consumer");
const e2e = process.argv.includes("--e2e");

const run = (command, args, cwd, env = process.env) =>
	new Promise((done, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? done() : reject(new Error(`${command} exited with ${code ?? 1}`))));
	});

const pack = async (cwd) => {
	const before = new Set(await readdir(artifacts));
	await run("pnpm", ["pack", "--pack-destination", artifacts], cwd);
	const tarball = (await readdir(artifacts)).find((entry) => entry.endsWith(".tgz") && !before.has(entry));
	if (tarball === undefined) throw new Error(`pnpm pack did not create a tarball for ${cwd}`);
	return resolve(artifacts, tarball);
};

if (e2e && !process.env.VERCEL_OIDC_TOKEN?.trim()) {
	throw new Error("VERCEL_OIDC_TOKEN is required for the installed-package E2E");
}

try {
	await run("pnpm", ["run", "build"], harness);
	await run("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], external);
	await Promise.all([mkdir(artifacts), mkdir(consumer)]);
	const harnessTarball = await pack(harness);
	const externalTarball = await pack(external);

	await writeFile(
		resolve(consumer, "package.json"),
		`${JSON.stringify(
			{
				name: "sandbox-package-consumer",
				private: true,
				type: "module",
				dependencies: {
					"@codeworksh/harness": `file:${harnessTarball}`,
					"@codeworksh-test/codework-sandbox-vercel": `file:${externalTarball}`,
					effect: "4.0.0-beta.107",
				},
			},
			null,
			2,
		)}\n`,
	);

	// The smoke only loads JavaScript, so the optional native accelerators stay unbuilt.
	// pnpm fails the install on undeclared ignored build scripts, so decline them explicitly.
	// Effect's own caret ranges match across prerelease tags, so a fresh install otherwise
	// pairs a newer platform-node-shared with the effect version the harness is built against.
	await writeFile(
		resolve(consumer, "pnpm-workspace.yaml"),
		`${dedent`
			overrides:
			  "@effect/platform-node-shared": 4.0.0-beta.107
			allowBuilds:
			  "@mongodb-js/zstd": false
			  esbuild: false
			  lmdb: false
			  msgpackr-extract: false
			  node-liblzma: false
			  protobufjs: false
		`}\n`,
	);

	await writeFile(
		resolve(consumer, "smoke.mjs"),
		`${dedent`
			import assert from "node:assert/strict";
			import { Effect, ManagedRuntime, Option } from "effect";
			import { Harness, Sandbox } from "@codeworksh/harness/effect";

			const runtime = ManagedRuntime.make(Harness.layer({
				database: ":memory:",
				home: new URL("./home", import.meta.url).pathname,
				sandboxes: ["@codeworksh-test/codework-sandbox-vercel"],
			}));
			let created;
			const failures = [];

			try {
				const drivers = await runtime.runPromise(Sandbox.drivers());
				const external = drivers.find((driver) => driver.name === "codework.test.vercel");
				if (external === undefined || external.source !== "package") {
					throw new Error("installed sandbox driver was not registered from its package");
				}

				if (${JSON.stringify(e2e)}) {
					created = await runtime.runPromise(Sandbox.create({
						driver: "codework.test.vercel",
						config: { runtime: "node24", timeout: 300000, execTimeout: 30000 },
					}));
					assert.equal((await runtime.runPromise(Sandbox.refresh(created.id))).status, "online");
					assert.equal((await runtime.runPromise(Sandbox.stop(created.id))).status, "offline");
					assert.equal((await runtime.runPromise(Sandbox.wake(created.id))).status, "online");
					assert.equal((await runtime.runPromise(Sandbox.stop(created.id))).status, "offline");
					await runtime.runPromise(Sandbox.destroy(created.id));
					assert.equal(Option.getOrThrow(await runtime.runPromise(Sandbox.get(created.id))).status, "removed");
					created = undefined;
				}
			} catch (cause) {
				failures.push(cause);
			} finally {
				if (created !== undefined) {
					await runtime.runPromise(Sandbox.stop(created.id)).catch((cause) => failures.push(cause));
					await runtime.runPromise(Sandbox.destroy(created.id)).catch((cause) => failures.push(cause));
				}
				await runtime.dispose().catch((cause) => failures.push(cause));
			}
			if (failures.length > 0) throw new AggregateError(failures, "installed-package smoke failed");
		`}\n`,
	);

	await run("pnpm", ["install"], consumer);
	await run("node", ["smoke.mjs"], consumer);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
