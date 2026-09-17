/*
 * A third-party tool plugin, vendored as a worked example. It uses only the public plugin,
 * tool and sandbox surfaces, and default-exports one plugin object — what the loader imports.
 *
 * Two entries: one names the module, the next configures it by the package name.
 *
 *   { "plugins": ["@acme/codework-tool-proc@1.2.0",
 *                 { "package": "@acme/codework-tool-proc", "options": { "limit": 40 } }] }
 *
 * In this repository the module entry is a path, because this example ships TypeScript and Node
 * refuses to strip types under `node_modules`. A plugin package published for real ships built
 * JavaScript; see the README.
 */
import { Plugin, Tool } from "@codeworksh/harness/effect";
import { SandboxIO } from "@codeworksh/harness/sandbox";
import { Effect, Schema } from "effect";

/** Rows to return when the entry carries no `limit`. */
const DEFAULT_LIMIT = 20;
/** `ps` fields, printed headerless (`=`) so there is nothing to skip while parsing. */
const COMMAND = "ps -eo pid=,pcpu=,pmem=,args=";
const ROW = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/;

/**
 * The plugin's own configuration block. The harness never inspects it, so every field is
 * checked here and a malformed one falls back rather than failing the boot.
 */
const readLimit = (options: Plugin.PluginOptions): number => {
	const limit = options["limit"];
	return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
};

const ProcParams = Schema.Struct({
	filter: Schema.optional(
		Schema.String.annotate({ description: "Only list processes whose command line contains this text." }),
	),
});

const ProcessRow = Schema.Struct({
	pid: Schema.Finite,
	cpu: Schema.Finite,
	memory: Schema.Finite,
	command: Schema.String,
});

const ProcSuccess = Schema.Struct({
	processes: Schema.Array(ProcessRow),
	/** How many matched in total, which is more than `processes.length` when `limit` cut the list. */
	matched: Schema.Finite,
});

/** A non-zero `ps` is expected and model-visible: the model can retry with a different filter. */
class ProcFailed extends Schema.TaggedError<ProcFailed>()("ProcFailed", {
	exitCode: Schema.Finite,
	stderr: Schema.String,
}) {}

const parse = (stdout: string): ReadonlyArray<typeof ProcessRow.Type> => {
	const rows: Array<typeof ProcessRow.Type> = [];
	for (const line of stdout.split("\n")) {
		const match = ROW.exec(line);
		if (match === null) continue;
		const [, pid, cpu, memory, command] = match;
		rows.push({
			pid: Number(pid),
			cpu: Number(cpu),
			memory: Number(memory),
			command: (command ?? "").trim(),
		});
	}
	return rows;
};

const table = (rows: ReadonlyArray<typeof ProcessRow.Type>): string =>
	[
		"PID      CPU%   MEM%  COMMAND",
		...rows.map(
			(row) =>
				`${String(row.pid).padEnd(8)} ${row.cpu.toFixed(1).padStart(5)} ${row.memory
					.toFixed(1)
					.padStart(5)}  ${row.command}`,
		),
	].join("\n");

export default Plugin.define({
	id: "acme.tool.proc",
	setup: Effect.fn("ProcPlugin.setup")(function* (ctx, options) {
		// The sandbox's shell, not `node:child_process`: the tool lists processes wherever the
		// session actually runs — this machine, a container, or a remote sandbox.
		const shell = yield* SandboxIO.Shell;
		const limit = readLimit(options);
		ctx.plugin.tools.add(
			Tool.register(
				Tool.make({
					name: "list_processes",
					label: "processes",
					promptSnippet: "List the processes running in the session's environment.",
					description:
						"List running processes with their PID, CPU and memory share, and command line. " +
						`Returns at most ${limit} rows, busiest first; pass \`filter\` to narrow by command line.`,
					parameters: ProcParams,
					success: ProcSuccess,
					failure: ProcFailed,
					encodeContent: (success) =>
						success.processes.length === 0
							? [{ type: "text", text: "No matching processes." }]
							: [{ type: "text", text: table(success.processes) }],
					encodeFailureContent: (failure) => [{ type: "text", text: failure.stderr }],
					handler: (params) =>
						Effect.gen(function* () {
							const result = yield* shell
								.exec(COMMAND)
								// A shell that cannot run at all is infrastructure, not something the
								// model can act on, so it becomes a defect rather than a tool failure.
								.pipe(Effect.catchTag("ShellError", (cause) => Effect.die(cause)));
							if (result.exitCode !== 0) {
								return yield* new ProcFailed({ exitCode: result.exitCode, stderr: result.stderr });
							}
							const filter = params.filter?.toLowerCase();
							const matched = parse(result.stdout).filter(
								(row) => filter === undefined || row.command.toLowerCase().includes(filter),
							);
							const processes = [...matched].sort((a, b) => b.cpu - a.cpu).slice(0, limit);
							return { processes, matched: matched.length } satisfies typeof ProcSuccess.Type;
						}),
				}),
			),
		);
	}),
});
