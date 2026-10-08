import { Effect } from "effect";
import { Hex } from "effect/encoding";
import { crypto } from "../host.ts";
import { quote } from "../sandbox/shell/shell.ts";
import { posix } from "../util/posix.ts";

/**
 * Output files: where a tool keeps output it did not show in full, so the model
 * can still read it. They live inside the sandbox, under the mount's spill path,
 * because that is where the model's tools can reach them; the command writes its
 * own output there, so the full output never has to cross to the harness.
 *
 * A file is created mode 0600 (output can carry secrets) and exclusively, so it
 * is never a link someone else placed at the path. It is kept exactly when the
 * raw output exceeds the limits, and otherwise removed before the command returns.
 */

export interface Limits {
	readonly maxLines: number;
	readonly maxBytes: number;
}

/** A new, unused output file path under `spillPath`. */
export const path = (spillPath: string, prefix: string) =>
	crypto.randomBytes(8).pipe(
		Effect.map((bytes) => posix.join(spillPath, `${prefix}-${Hex.encode(bytes)}.log`)),
		Effect.orDie,
	);

/** First line printed when the output file cannot be created; the command then runs unsaved. */
export const unsaved = (file: string) => `codework: output not saved, cannot create ${file}`;

const HEADER = "codework-output";

/** Twice the byte limit leaves room to find where the shown lines start. */
export const windowBytes = (limits: Limits) => limits.maxBytes * 2;

/**
 * The wrapper. The command's combined output goes through `pipeline` into the
 * file; the file's size then decides whether it is kept, and `report` lines run
 * before an unkept file is removed.
 */
const script = (
	command: string,
	file: string,
	limits: Limits,
	pipeline: (source: string) => string,
	report: ReadonlyArray<string> = [],
) =>
	[
		`f=${quote(file)}`,
		// A function whose body is a subshell: `exit` in the command ends only it,
		// and the command is written once for both branches below.
		"run() (",
		command,
		")",
		// `umask` may be missing where modes mean nothing (an in-process shell over a virtual filesystem).
		`if mkdir -p ${quote(posix.dirname(file))} 2>/dev/null && (umask 077 2>/dev/null; set -C && : > "$f") 2>/dev/null; then`,
		// A pipe ends only when every writer — background jobs included — has
		// closed it. POSIX `sh` has no `pipefail`, so the exit code travels
		// through a side file.
		`\t${pipeline('{ run 2>&1; echo $? > "$f.rc"; }')}`,
		'\trc=$(cat "$f.rc" 2>/dev/null); rm -f "$f.rc"',
		// The argument form, not `< "$f"`: some in-process shells lose the
		// variable in a redirect inside a command substitution.
		`\tb=$(wc -c "$f" | awk '{ print $1 }'); n=$(wc -l "$f" | awk '{ print $1 }'); l=$n`,
		// Lines as the harness counts them: a final line without a newline counts.
		// `wc -l` on the last byte, since command substitution drops a NUL.
		`\t[ -s "$f" ] && [ "$(tail -c 1 "$f" | wc -l | awk '{ print $1 }')" = 0 ] && l=$((l + 1))`,
		`\tkeep=0; { [ "$b" -gt ${limits.maxBytes} ] || [ "$l" -gt ${limits.maxLines} ]; } && keep=1`,
		...report.map((line) => `\t${line}`),
		'\t[ "$keep" = 1 ] || rm -f "$f"',
		'\texit "${rc:-1}"',
		"fi",
		`printf '%s\\n' ${quote(unsaved(file))}`,
		"run 2>&1",
	].join("\n");

/** For a backend that streams: all output still flows back as it is produced, and a copy lands in the file. */
export const streaming = (command: string, file: string, limits: Limits) =>
	script(command, file, limits, (source) => `${source} | tee -a "$f"`);

/**
 * For a backend that returns output only at the end: the output goes to the
 * file, and only a header — its size, and whether the file was kept — and a
 * tail window come back. The bytes before the window are skipped, and counted.
 */
export const buffered = (command: string, file: string, limits: Limits) =>
	script(
		command,
		file,
		limits,
		// The redirect sits on the whole group, not on `cat`: an in-process shell
		// (just-bash) re-encodes text that a command reading a pipe writes to a file.
		(source) => `{ ${source} | cat; } >> "$f"`,
		[
			`printf '${HEADER} %s %s %s\\n' "$b" "$n" "$keep"`,
			`tail -n ${limits.maxLines} "$f" | tail -c ${windowBytes(limits)}`,
		],
	);

export interface Window {
	/** The end of the output: whole lines, unless the byte cap cut into the first. */
	readonly text: string;
	/** Bytes and newlines in the whole output. */
	readonly bytes: number;
	readonly newlines: number;
	/** Whether the sandbox kept the output file — decided on raw bytes, which the harness only sees decoded. */
	readonly kept: boolean;
}

const header = new RegExp(`^${HEADER} (\\d+) (\\d+) ([01])$`);

/** Read {@link buffered}'s result; `undefined` when the output was not saved and came back whole. */
export const window = (stdout: string): Window | undefined => {
	const newline = stdout.indexOf("\n");
	const match = header.exec(newline === -1 ? stdout : stdout.slice(0, newline));
	if (match === null) return undefined;
	return {
		text: stdout.slice(newline + 1),
		bytes: Number(match[1]),
		newlines: Number(match[2]),
		kept: match[3] === "1",
	};
};

export * as Output from "./output.ts";
