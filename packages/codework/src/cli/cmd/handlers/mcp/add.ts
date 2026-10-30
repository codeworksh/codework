import { McpConfig } from "@codeworksh/harness/effect";
import { Effect, Option, Predicate } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { InvalidInputError, reportFailure } from "../../../error.ts";
import { Jsonc } from "../../../jsonc.ts";
import { writeOut } from "../../../output.ts";
import { Cmd } from "../../cmd.ts";
import { configured, readServers } from "./shared.ts";

const HTTP_ONLY = [
	"header",
	"bearerTokenEnvVar",
	"oauthClientId",
	"oauthClientSecret",
	"oauthCallbackPort",
	"oauthClientName",
] as const;
const STDIO_ONLY = ["env", "cwd"] as const;
const FLAGS: Record<(typeof HTTP_ONLY)[number] | (typeof STDIO_ONLY)[number], string> = {
	header: "--header",
	bearerTokenEnvVar: "--bearer-token-env-var",
	oauthClientId: "--oauth-client-id",
	oauthClientSecret: "--oauth-client-secret",
	oauthCallbackPort: "--oauth-callback-port",
	oauthClientName: "--oauth-client-name",
	env: "--env",
	cwd: "--cwd",
};

/** Only the options that were given, so the entry carries no empty keys. */
const present = (record: Record<string, Option.Option<unknown>>) =>
	Object.fromEntries(
		Object.entries(record).flatMap(([key, value]) => (Option.isSome(value) ? [[key, value.value]] : [])),
	);

export default Runtime.handler(
	Cmd.commands.mcp.commands.add,
	Effect.fn("CLI.mcp.add")(function* (input) {
		const program = Effect.gen(function* () {
			const { name } = input;
			// The parser leaves what follows `--` to the root command, so the server's command is read
			// from argv; that also lets it carry its own flags, as in `npx -y`.
			const dash = process.argv.indexOf("--");
			const command = dash === -1 ? [...input.command] : process.argv.slice(dash + 1);
			const url = Option.getOrUndefined(input.url);
			if (url === undefined && command.length === 0)
				return yield* new InvalidInputError({
					message: "give either --url <url> or the server's command after --",
				});
			if (url !== undefined && command.length > 0)
				return yield* new InvalidInputError({
					message: "give either --url <url> or the server's command after --, not both",
				});
			const misplaced = (url === undefined ? HTTP_ONLY : STDIO_ONLY).find((key) =>
				Option.isSome(input[key] as Option.Option<unknown>),
			);
			if (misplaced !== undefined)
				return yield* new InvalidInputError({
					message: `${FLAGS[misplaced]} only applies to ${url === undefined ? "HTTP servers (--url)" : "stdio servers"}`,
				});

			let config: Record<string, unknown>;
			if (url !== undefined) {
				const headers = { ...Option.getOrElse(input.header, () => ({})) };
				if (Option.isSome(input.bearerTokenEnvVar))
					headers.Authorization = `Bearer \${${input.bearerTokenEnvVar.value}}`;
				const oauth = present({
					clientId: input.oauthClientId,
					clientSecret: input.oauthClientSecret,
					callbackPort: input.oauthCallbackPort,
					clientName: input.oauthClientName,
				});
				config = {
					url,
					...(Object.keys(headers).length > 0 ? { headers } : {}),
					...(Object.keys(oauth).length > 0 ? { oauth } : {}),
				};
			} else {
				const [executable, ...args] = command;
				config = {
					command: executable,
					...(args.length > 0 ? { args } : {}),
					...present({ env: input.env, cwd: input.cwd }),
				};
			}
			Object.assign(config, present({ exposure: input.exposure, description: input.description }));
			const validated = McpConfig.validate(name, config);
			if (Predicate.isString(validated)) return yield* new InvalidInputError({ message: validated });

			const { user, project } = yield* configured();
			const path = input.local ? project : user;
			const replaced = yield* Jsonc.locked(
				path,
				Effect.gen(function* () {
					const { source, servers } = yield* readServers(path);
					yield* Jsonc.write(path, source, ["mcpServers", name], validated);
					return servers[name] !== undefined;
				}),
			);
			const level = input.local ? "project" : "user";
			yield* writeOut(`${replaced ? "Replaced" : "Added"} ${level} MCP server "${name}" in ${path}.\n`);
			// HTTP servers without an Authorization header may use OAuth.
			const signIn =
				"url" in validated &&
				!Object.keys(validated.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
			yield* writeOut(
				`Check it with: codework mcp list${signIn ? `. If it requires sign-in: codework mcp login ${name}` : ""}\n`,
			);
		});
		return yield* program.pipe(Effect.catch(reportFailure));
	}),
);
