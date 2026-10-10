import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { SandboxFileSystem } from "../src/sandbox/fs/filesystem.ts";
import { files, label, reference, windows } from "./fixtures/scan.corpus.ts";
import { tmpdir } from "./fixtures/tempdir.ts";

/**
 * `scanLines` has two implementations that must agree byte for byte: the
 * streaming scanner local backends use, and the shell script remote backends
 * run inside the sandbox, whose output crosses a wire and is parsed back. Ways
 * they could disagree, each covered by the corpus:
 *   - a trailing newline counted as an extra empty line, or a blank line dropped
 *   - a byte-order mark kept, or a short file that merely starts like one eaten
 *   - a line or a mark split across chunks handled differently
 *   - lengths counted in characters instead of bytes (multi-byte text)
 *   - a line that does not fit taken partially, or lines after it taken
 *   - `%` or `\n` in the text interpreted by the script's printf
 *   - trailing whitespace lost on the way back
 *   - a window past the end of the file
 */

const run = promisify(execFile);

const scanFile = (bytes: Uint8Array, options: SandboxFileSystem.LineScanOptions, chunk: number) => {
	const scanner = new SandboxFileSystem.Scan.LineScanner(options);
	for (let from = 0; from < bytes.length; from += chunk) scanner.push(bytes.subarray(from, from + chunk));
	return scanner.finish();
};

// The host's own `sh` and `awk`, as a remote sandbox would run them.
const viaHostShell = SandboxFileSystem.Scan.viaShell(async (argv) => {
	try {
		const { stdout, stderr } = await run(argv[0]!, argv.slice(1), { encoding: "utf8" });
		return { exitCode: 0, stdout, stderr };
	} catch (cause) {
		const failed = cause as { code?: number; stdout?: string; stderr?: string };
		return { exitCode: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
	}
});

describe("SandboxFileSystem.Scan", () => {
	it("agrees across the scanner, the shell script, and the reference", async () => {
		await using tmp = await tmpdir();
		const report: Record<string, Record<string, SandboxFileSystem.LineScan>> = {};
		for (const [name, bytes] of Object.entries(files)) {
			const file = path.join(tmp.path, name);
			await fs.writeFile(file, bytes);
			report[name] = {};
			for (const options of windows) {
				const expected = reference(bytes, options);
				expect(scanFile(bytes, options, 1), `${name} ${label(options)} bytewise`).toEqual(expected);
				expect(scanFile(bytes, options, bytes.length || 1), `${name} ${label(options)} whole`).toEqual(expected);
				expect(await viaHostShell(file, options), `${name} ${label(options)} shell`).toEqual(expected);
				report[name][label(options)] = expected;
			}
		}

		await expect(viaHostShell(path.join(tmp.path, "missing"), windows[0]!)).rejects.toSatisfy((cause) =>
			SandboxFileSystem.isNotFoundError(cause),
		);
		await expect(JSON.stringify(report, null, "\t") + "\n").toMatchFileSnapshot("./__artifacts__/sandbox.scan.json");
	});
});
