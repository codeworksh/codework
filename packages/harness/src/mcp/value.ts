/**
 * Values of a server's `env` and `headers`, resolved when the server connects:
 *
 * - `!command` runs the rest through `/bin/sh` and uses its trimmed stdout, once per process: later
 *   and concurrent connects share it. A command that fails runs again next time, since the host
 *   outlives sessions.
 * - Otherwise `$NAME` and `${NAME}` are replaced by host environment variables; `$$` is a literal
 *   `$` and `$!` a literal `!`. Anything else is literal.
 *
 * A header holding a line break or NUL, or a variable holding NUL, is refused without being shown: it
 * cannot be sent or set, and the error the runtime would raise quotes the value, often a secret. A
 * variable may span lines (a PEM key, say).
 */

import { Config, Duration, Effect, Fiber, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const COMMAND_TIMEOUT = Duration.seconds(10);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;
const COMMAND_KILL_AFTER = Duration.seconds(2);
const UNSAFE = {
	header: { pattern: /[\r\n\0]/, what: "a line break or NUL character" },
	env: { pattern: /\0/, what: "a NUL character" },
} as const;
const commands = new Map<string, Fiber.Fiber<string | undefined>>();

type Part = { readonly type: "literal"; readonly value: string } | { readonly type: "env"; readonly name: string };

const template = (value: string): ReadonlyArray<Part> => {
	const parts: Part[] = [];
	const literal = (text: string) => {
		if (!text) return;
		const last = parts.at(-1);
		if (last?.type === "literal") parts[parts.length - 1] = { type: "literal", value: last.value + text };
		else parts.push({ type: "literal", value: text });
	};
	let index = 0;
	while (index < value.length) {
		const dollar = value.indexOf("$", index);
		if (dollar < 0) {
			literal(value.slice(index));
			break;
		}
		literal(value.slice(index, dollar));
		const next = value[dollar + 1];
		if (next === "$" || next === "!") {
			literal(next);
			index = dollar + 2;
			continue;
		}
		if (next === "{") {
			const end = value.indexOf("}", dollar + 2);
			if (end < 0) {
				literal("$");
				index = dollar + 1;
				continue;
			}
			const name = value.slice(dollar + 2, end);
			if (NAME.test(name)) parts.push({ type: "env", name });
			else literal(value.slice(dollar, end + 1));
			index = end + 1;
			continue;
		}
		const match = NAME_PREFIX.exec(value.slice(dollar + 1));
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollar + 1 + match[0].length;
			continue;
		}
		literal("$");
		index = dollar + 1;
	}
	return parts;
};

/** stdout of `command`, or nothing when it fails, exits non-zero, prints nothing or times out. */
const run = (command: string) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const handle = yield* spawner.spawn(
			// A helper that ignores SIGTERM must not outlast the timeout.
			ChildProcess.make("/bin/sh", ["-c", command], {
				stdin: "ignore",
				stderr: "ignore",
				forceKillAfter: COMMAND_KILL_AFTER,
			}),
		);
		const [output, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
			concurrency: 2,
		});
		const trimmed = output.trim();
		return code === 0 && trimmed ? trimmed : undefined;
	}).pipe(
		Effect.scoped,
		Effect.timeoutOption(COMMAND_TIMEOUT),
		Effect.map((value) => (value._tag === "Some" ? value.value : undefined)),
		Effect.orElseSucceed(() => undefined),
	);

const command = Effect.fnUntraced(function* (line: string, what: string) {
	let running = commands.get(line);
	if (running === undefined) {
		// Detached, so a caller giving up does not stop it for the others waiting on it.
		running = yield* Effect.forkDetach(run(line));
		commands.set(line, running);
	}
	const output = yield* Fiber.join(running);
	if (output === undefined) {
		if (commands.get(line) === running) commands.delete(line);
		return yield* Effect.fail(`Failed to resolve ${what} from shell command: ${line}`);
	}
	return output;
});

const variables = Effect.fnUntraced(function* (value: string, what: string) {
	const parts = template(value);
	const names = [...new Set(parts.flatMap((part) => (part.type === "env" ? [part.name] : [])))];
	// An empty variable counts as unset.
	const env = new Map<string, string>();
	for (const name of names) {
		const found = yield* Config.option(Config.String(name)).pipe(Effect.orElseSucceed(() => Option.none<string>()));
		if (Option.isSome(found) && found.value !== "") env.set(name, found.value);
	}
	const missing = names.filter((name) => !env.has(name));
	if (missing.length > 0)
		return yield* Effect.fail(
			`Failed to resolve ${what} from environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
		);
	return parts.map((part) => (part.type === "literal" ? part.value : env.get(part.name))).join("");
});

/**
 * One value, used as `kind`. `what` names it in the failure, for example
 * `MCP server "docs" header "Authorization"`.
 */
export const resolve = Effect.fnUntraced(function* (value: string, kind: keyof typeof UNSAFE, what: string) {
	const resolved = yield* value.startsWith("!") ? command(value.slice(1), what) : variables(value, what);
	if (UNSAFE[kind].pattern.test(resolved)) return yield* Effect.fail(`${what} contains ${UNSAFE[kind].what}`);
	return resolved;
});

/** Every value of a record, failing on the first that does not resolve. */
export const resolveAll = Effect.fnUntraced(function* (
	values: Readonly<Record<string, string>>,
	kind: keyof typeof UNSAFE,
	what: string,
) {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) resolved[key] = yield* resolve(value, kind, `${what} "${key}"`);
	return resolved;
});

export * as McpValue from "./value.ts";
