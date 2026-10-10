import { Effect, Layer } from "effect";
import { findTool } from "../../src/plugin/builtin/tool/find.ts";
import { grepTool } from "../../src/plugin/builtin/tool/grep.ts";
import { lsTool } from "../../src/plugin/builtin/tool/ls.ts";
import { SandboxIO } from "../../src/sandbox/io.ts";
import { Binary } from "../../src/tool/binary.ts";
import * as Executor from "../../src/tool/executor.ts";
import * as Tool from "../../src/tool/tool.ts";
import { pendingCall } from "../tools.fixture.ts";

/**
 * One tree and one set of grep / find / ls calls, run on every sandbox the search
 * tools support. The cases follow Pi's own tool tests and regressions (#3302 path
 * globs, #3303 nested .gitignore), plus the limits and truncation Pi documents.
 */

export const files: Record<string, string> = {
	".git/HEAD": "ref: refs/heads/main\n",
	".gitignore": "dist/\n*.log\n!keep.log\n",
	".hidden/secret.ts": "export const needle = 1;\n",
	"README.md": "# Needle\nA needle in a haystack.\n",
	"a.b.txt": "literal a.b here\naxb is not literal\n",
	"build.log": "needle in an ignored log\n",
	"keep.log": "needle kept by negation\n",
	"dist/out.js": "needle in ignored dist\n",
	"context.txt": ["before", "match one", "after", "middle", "match two", "after two"].join("\n"),
	"long.txt": `match ${"x".repeat(600)}\n`,
	"huge.txt": `before\nhit ${"y".repeat(60_000)}\nafter\n`,
	// Run by ripgrep only if a pattern were read as its `--pre` flag.
	"payload.sh": '#!/bin/sh\necho executed > "$(dirname "$0")/injected"\ncat "$1"\n',
	"src/.gitignore": "generated.ts\n",
	"src/generated.ts": "needle generated\n",
	"src/index.ts": "import { needle } from './util';\n\nconsole.log(needle);\nconsole.log('done');\n",
	"src/util.ts": "// helpers\nexport const needle = 'NEEDLE';\nexport const other = 2;\n",
	"src/nested/deep.spec.ts": "describe('needle', () => {});\n",
	"a/.gitignore": "ignored.txt\n",
	"a/ignored.txt": "",
	"a/kept.txt": "",
	"a/deep/.gitignore": "secret.txt\n",
	"a/deep/secret.txt": "",
	"a/deep/kept.txt": "",
	"b/ignored.txt": "",
	"b/kept.txt": "",
};

type Cases = Record<string, Record<string, unknown>>;

export const grepCases: Cases = {
	basic: { pattern: "needle" },
	"ignore-case": { pattern: "NEEDLE", ignoreCase: true },
	"case-sensitive": { pattern: "NEEDLE" },
	regex: { pattern: "a.b" },
	literal: { pattern: "a.b", literal: true },
	"glob-basename": { pattern: "needle", glob: "*.ts" },
	"glob-path": { pattern: "needle", glob: "**/*.spec.ts" },
	context: { pattern: "console.log\\(needle", context: 1 },
	// Pi: the limit is global, and the context of the one match shown still comes with it.
	"limit-context": { pattern: "match", path: "context.txt", limit: 1, context: 1 },
	limit: { pattern: "needle", limit: 2 },
	"single-file": { pattern: "needle", path: "src/util.ts" },
	subdir: { pattern: "needle", path: "src" },
	"dash-pattern": { pattern: "-x" },
	// Pi: a pattern that looks like a flag is searched for, never obeyed.
	"flag-pattern": { pattern: "--pre=./payload.sh" },
	"no-match": { pattern: "absent-token" },
	"long-line": { pattern: "match x" },
	// A match line over the scan's byte bound still shows, cut, between its context lines.
	"huge-context": { pattern: "hit y", context: 1 },
	"missing-path": { pattern: "needle", path: "nope" },
};

/**
 * The one known difference between ripgrep and just-bash's: ripgrep lets a
 * `--glob` override ignore rules, so the gitignored `src/generated.ts` matches
 * `*.ts`; just-bash's rg keeps ignoring it.
 */
export const VARIANCE = "glob-basename";

export const lsCases: Cases = {
	// Pi: dotfiles and dot-directories are listed.
	root: {},
	subdir: { path: "src" },
	limit: { limit: 2 },
	empty: { path: "empty" },
	file: { path: "README.md" },
	missing: { path: "nope" },
};

export const findCases: Cases = {
	// Pi: hidden files are found unless ignored.
	basename: { pattern: "*.ts" },
	"with-path": { pattern: "src/**/*.ts" },
	// Pi #3302: a pattern with a directory in it matches the path, not the basename.
	"spec-path": { pattern: "src/**/*.spec.ts" },
	subtree: { pattern: "src/nested/**" },
	"leading-globstar": { pattern: "**/nested/*" },
	// Pi #3303: each .gitignore applies to its own subtree only.
	"nested-gitignore": { pattern: "*.txt", path: "a" },
	"sibling-gitignore": { pattern: "*.txt", path: "b" },
	negated: { pattern: "*.log" },
	directory: { pattern: "nested" },
	// fd stops at whichever match a thread finds first, so the limit is hit by the only match.
	limit: { pattern: "*.log", limit: 1 },
	none: { pattern: "*.nothing" },
	// Pi: a flag-like pattern is a pattern; a glob fd cannot parse is reported.
	"flag-pattern": { pattern: "--help" },
	"bad-glob": { pattern: "[" },
	missing: { pattern: "*.ts", path: "nope" },
};

const settle = (outcome: Executor.ToolOutcome) => {
	const part = outcome.result.content[0];
	return {
		status: outcome.status,
		text: part?.type === "text" ? part.text : undefined,
		...(outcome.result.details === undefined ? {} : { details: outcome.result.details }),
	};
};

export interface Results {
	readonly grep: Record<string, unknown>;
	readonly ls: Record<string, unknown>;
	readonly find: Record<string, unknown>;
	/** Whether anything ran the payload. */
	readonly injected: boolean;
}

/** Write the tree into the mount, relative to its cwd, and run every case. */
export const runAll = <E>(mount: SandboxIO.Layer<E>, bin: string): Promise<Results> =>
	Effect.gen(function* () {
		const sandbox = yield* SandboxIO.FileSystem;
		const shell = yield* SandboxIO.Shell;
		for (const [path, content] of Object.entries(files)) yield* sandbox.writeFile(path, content);
		yield* sandbox.mkdir("empty", { recursive: true });
		yield* shell.exec("chmod +x payload.sh");

		const services = Layer.mergeAll(
			Layer.succeed(SandboxIO.FileSystem, sandbox),
			Layer.succeed(SandboxIO.Shell, shell),
			Layer.succeed(SandboxIO.Current, yield* SandboxIO.Current),
			Layer.succeed(Binary.HostBin, bin),
		);
		const executor = Executor.make([
			Tool.provide(grepTool, services),
			Tool.provide(findTool, services),
			Tool.provide(lsTool, services),
		]);
		const call = (tool: string, cases: Cases) =>
			Effect.gen(function* () {
				const results: Record<string, unknown> = {};
				for (const [name, args] of Object.entries(cases))
					results[name] = settle(yield* executor.handle(pendingCall(tool, args, `${tool}-${name}`)));
				return results;
			});
		return {
			grep: yield* call("grep", grepCases),
			ls: yield* call("ls", lsCases),
			find: yield* call("find", findCases),
			injected: yield* sandbox.exists("injected"),
		};
	}).pipe(Effect.provide(mount), Effect.runPromise);

/** Results with the mount's root spelled `<root>`, so mounts compare. */
export const normalize = (results: Results, root: string): Results =>
	JSON.parse(JSON.stringify(results).replaceAll(root, "<root>"));

/** grep results without the case ripgrep and just-bash answer differently. */
export const comparableGrep = (results: Results) => {
	const { [VARIANCE]: _, ...rest } = results.grep;
	return rest;
};
