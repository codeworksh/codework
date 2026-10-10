import { Effect } from "effect";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { Sandbox } from "../../src/sandbox/sandbox.ts";
import { SandboxIO } from "../../src/sandbox/io.ts";
import { Binary } from "../../src/tool/binary.ts";
import { normalize, runAll } from "./search.ts";
import { tmpdir } from "./tempdir.ts";

const TIMEOUT = 600_000;

/** The command each search binary resolves to in the mounted sandbox, `$HOME` spelled out. */
const resolved = <E>(mount: SandboxIO.Layer<E>) =>
	Effect.gen(function* () {
		const sandbox = yield* SandboxIO.Current;
		const shell = yield* SandboxIO.Shell;
		const fs = yield* SandboxIO.FileSystem;
		const home = (yield* shell.exec('printf %s "$HOME"')).stdout.trim();
		const command = (name: Binary.Name) =>
			Effect.map(Binary.ensure(name, sandbox, shell, fs), (result) =>
				result._tag === "Available" ? result.command.replace(home, "$HOME") : undefined,
			);
		return { rg: yield* command("rg"), fd: yield* command("fd") };
	}).pipe(Effect.provide(mount), Effect.provideService(Binary.HostBin, "/unused"), Effect.runPromise);

/**
 * grep, find and ls on a remote sandbox owned by the parent suite, mounted at a
 * fresh directory so no other spec's files show up. A fresh instance id means a
 * fresh probe: a sandbox without rg or fd gets them installed by the tools.
 * Real ripgrep and fd run on both sides, so every answer must be the host's.
 */
export const searchRemoteSpec = (name: string, mount: (cwd: string) => Promise<SandboxIO.Layer<unknown>>) =>
	describe(`search tools × shared ${name} sandbox`, () => {
		it(
			"answer exactly what the host answers",
			async () => {
				await using temp = await tmpdir();
				const root = await fs.realpath(temp.path);
				const host = normalize(
					await runAll(
						Sandbox.services(Sandbox.EnvNodeJSDefault.layer(), SandboxIO.host(root)),
						`${root}/home/bin`,
					),
					root,
				);
				const cwd = `/tmp/codework-search-${randomUUID()}`;
				const remote = normalize(await runAll(await mount(cwd), `${root}/unused-bin`), cwd);
				// What the tools ran: the image's own binary, or the copy they installed.
				const binaries = await resolved(await mount(cwd));
				expect(Object.values(binaries).every((command) => command !== undefined)).toBe(true);

				await expect(`${JSON.stringify({ binaries, ...remote }, null, "\t")}\n`).toMatchFileSnapshot(
					`./__artifacts__/tools.search.${name}.json`,
				);
				expect(remote.injected).toBe(false);
				expect(remote).toEqual(host);
			},
			TIMEOUT,
		);
	});
