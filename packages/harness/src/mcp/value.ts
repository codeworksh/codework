/**
 * Values of a server's `env` and `headers`, resolved when the server connects:
 *
 * - `!command` runs the rest through `/bin/sh` and uses its trimmed stdout.
 * - Otherwise `$NAME` and `${NAME}` are replaced by host environment variables; `$$` is a literal
 *   `$` and `$!` a literal `!`. Anything else is literal.
 */

import { Config, Duration, Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ValueError } from "./error.ts";

const COMMAND_TIMEOUT = Duration.seconds(10);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;

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
		const handle = yield* spawner.spawn(ChildProcess.make("/bin/sh", ["-c", command], { stderr: "ignore" }));
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

/** One value. `what` names it in the failure, for example `MCP server "docs" header "Authorization"`. */
export const resolve = Effect.fnUntraced(function* (value: string, what: string) {
	if (value.startsWith("!")) {
		const output = yield* run(value.slice(1));
		if (output === undefined)
			return yield* new ValueError({ message: `Failed to resolve ${what} from shell command: ${value.slice(1)}` });
		return output;
	}
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
		return yield* new ValueError({
			message: `Failed to resolve ${what} from environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
		});
	return parts.map((part) => (part.type === "literal" ? part.value : env.get(part.name))).join("");
});

/** Every value of a record, failing on the first that does not resolve. */
export const resolveAll = Effect.fnUntraced(function* (values: Readonly<Record<string, string>>, what: string) {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) resolved[key] = yield* resolve(value, `${what} "${key}"`);
	return resolved;
});

export * as McpValue from "./value.ts";
