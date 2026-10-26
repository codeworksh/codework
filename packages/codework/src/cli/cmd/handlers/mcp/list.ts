/* @effect-diagnostics preferSchemaOverJson:off -- `--json` prints the report as it is built. */
import { Mcp } from "@codeworksh/harness/effect";
import { Effect, References } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { configured } from "./shared.ts";

interface Report {
	readonly name: string;
	readonly level: "user" | "project";
	readonly file: string;
	/** The project `mcp.json` that overrides `enabled` or exposure of this user server. */
	readonly override?: string;
	readonly enabled: boolean;
	readonly exposure: string;
	readonly transport: string;
	readonly state: Mcp.State;
	readonly tools: ReadonlyArray<string>;
	/** Tools whose exposure differs from the server's, from `toolExposure`. */
	readonly toolExposure?: Record<string, string>;
	/** Whether the server offers resources. They are not listed: listing every one can take long. */
	readonly resources?: true;
	readonly error?: string;
}

const MARKS: Record<Mcp.State, string> = {
	connected: "✓",
	"needs-auth": "⚠",
	failed: "✗",
	connecting: "○",
	disconnected: "○",
	disabled: "○",
};

const describe = (report: Report) => {
	switch (report.state) {
		case "connected":
			return `connected, ${report.tools.length} tool${report.tools.length === 1 ? "" : "s"}`;
		case "needs-auth":
			return "needs sign-in";
		default:
			return report.state;
	}
};

export default Runtime.handler(
	Cmd.commands.mcp.commands.list,
	Effect.fn("CLI.mcp.list")(function* ({ json }) {
		const program = Effect.gen(function* () {
			const { home, authFile, hostCwd, root, user, servers, errors } = yield* configured();
			// Every connect problem is in the report; the service's own logs would only repeat it.
			const statuses = yield* Mcp.check({
				servers: servers.map((server) => [server.name, server.config] as const),
				directory: hostCwd,
				hostDir: root ?? hostCwd,
			}).pipe(
				Effect.provide(Mcp.layer({ hostCwd, home, authFile })),
				Effect.provideService(References.MinimumLogLevel, "None"),
			);
			const reports = servers.map((server): Report => {
				const { config } = server;
				const status = statuses.find((one) => one.server === server.name);
				const exposure = config.exposure ?? "direct";
				const tools = status?.tools ?? [];
				const overrides = tools.filter((tool) => tool.exposure !== exposure);
				const state = status?.state ?? "disabled";
				return {
					name: server.name,
					level: server.file === user ? "user" : "project",
					file: server.file,
					...(server.override === undefined ? {} : { override: server.override }),
					enabled: config.enabled !== false,
					exposure,
					transport: "url" in config ? config.url : [config.command, ...(config.args ?? [])].join(" "),
					state,
					tools: tools.map((tool) => tool.name),
					...(overrides.length === 0
						? {}
						: { toolExposure: Object.fromEntries(overrides.map((tool) => [tool.name, tool.exposure])) }),
					...(status?.resources ? { resources: true as const } : {}),
					...(state !== "connected" && status?.error !== undefined ? { error: status.error } : {}),
				};
			});
			const failed = errors.length > 0 || reports.some((report) => report.enabled && report.state !== "connected");
			if (failed)
				yield* Effect.sync(() => {
					process.exitCode = 1;
				});

			if (json) return yield* writeOut(`${JSON.stringify({ servers: reports, errors }, null, 2)}\n`);
			const lines: string[] = [];
			if (reports.length === 0 && errors.length === 0)
				lines.push(`No MCP servers configured. Add them to ${user} or .codework/mcp.json.`);
			const width = Math.max(0, ...reports.map((report) => report.name.length));
			for (const report of reports) {
				lines.push(
					`${MARKS[report.state]} ${report.name.padEnd(width)}  ${describe(report)} (${report.exposure}, ${report.level})`,
				);
				const detail = (line: string) => lines.push(`    ${line}`);
				detail(report.transport);
				if (report.override !== undefined) detail(`project override: ${report.override}`);
				if (report.tools.length > 0)
					detail(
						`tools: ${report.tools
							.map((tool) => {
								const exposure = report.toolExposure?.[tool];
								return exposure === undefined ? tool : `${tool} [${exposure}]`;
							})
							.join(", ")}`,
					);
				if (report.resources) detail("offers resources");
				if (report.error !== undefined) for (const line of report.error.split("\n")) detail(line);
			}
			for (const error of errors) lines.push(`config error: ${error}`);
			yield* writeOut(`${lines.join("\n")}\n`);
		});
		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
