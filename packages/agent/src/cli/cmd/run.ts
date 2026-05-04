import type { Argv, ArgumentsCamelCase } from "yargs";
import { cmd } from "./cmd.ts";
import path from "node:path";
import { Filesystem } from "@codeworksh/utils";
import { UI } from "../ui.ts";
import { pathToFileURL } from "node:url";
import { Global } from "../../config/global.ts";
import { createCodeWorkClient, type CodeWorkSdkClient } from "@codeworksh/sdk";
import { Server } from "../../server/server.ts";
import { bootstrap } from "../bootstrap.ts";

interface RunArgs extends ArgumentsCamelCase {
	args: string[];
	title?: string;
	dir?: string;
	provider?: string;
	model?: string;
	name?: string;
	session?: string;
	continue?: boolean;
	"--"?: string[];
}

export const RunCommand = cmd({
	command: "run [args...]",
	describe: "run codework with a message and exit",
	builder: (yargs: Argv) => {
		return yargs
			.positional("args", {
				describe: "messages to send, optionally prefixed with @ for files",
				type: "string",
				array: true,
				default: [],
			})
			.option("dir", {
				type: "string",
				describe: "directory to run in",
			})
			.option("provider", {
				type: "string",
				describe: "provider",
			})
			.option("model", {
				type: "string",
				describe: "model",
			})
			.option("name", {
				type: "string",
				describe: "name for the session (uses truncated prompt if no value provided)",
			})
			.option("session", {
				alias: ["s"],
				type: "string",
				describe: "session ID to continue",
			})
			.option("continue", {
				alias: ["c"],
				describe: "continue the last session",
				type: "boolean",
			});
	},
	handler: async (args: RunArgs) => {
		const allArgs = [...args.args, ...(args["--"] || [])];
		const fileArgs = allArgs.filter((s) => s.startsWith("@")).map((s) => s.slice(1));
		const messages = allArgs.filter((s) => !s.startsWith("@"));

		const directory = (() => {
			if (!args.dir) return undefined;
			try {
				process.chdir(args.dir);
				return process.cwd(); // doing this normalizes path, resolves relative paths etc.
			} catch {
				UI.error("failed to change directory to " + args.dir);
				process.exit(1);
			}
		})();

		const files: {
			type: "file";
			url: string;
			filename: string;
			mime: string;
		}[] = [];
		if (fileArgs.length > 0) {
			for (const fp of fileArgs) {
				const resolvedPath = path.resolve(process.cwd(), fp);
				if (!(await Filesystem.exists(resolvedPath))) {
					UI.error(`File not found: ${fp}`);
					process.exit(1);
				}

				const mime = (await Filesystem.isDir(resolvedPath)) ? "application/x-directory" : "text/plain";

				files.push({
					type: "file",
					url: pathToFileURL(resolvedPath).href,
					filename: path.basename(resolvedPath),
					mime,
				});
			}
		}

		const hasMessage = () => {
			if (messages.length === 0) return false;
			return !(messages.length !== 0 && messages[0]!.trim().length === 0);
		};

		if (!hasMessage()) {
			UI.error("You must provide a message");
			process.exit(1);
		}

		function name() {
			if (args.name === undefined) return undefined;
			if (args.name !== "") return args.name;
			const message = messages.length > 0 ? messages[0]! : "";
			return message.slice(0, 50) + (message.length > 50 ? "..." : "");
		}

		async function session(sdk: CodeWorkSdkClient) {
			const existingSession = async (sessionId: string) => {
				try {
					const result = await sdk.session.get({ sessionId });
					return result.data?.id;
				} catch {
					return undefined;
				}
			};

			const baseId = args.continue
				? (await sdk.session.list()).data?.find((s) => !s.parentSessionId)?.id
				: args.session
					? await existingSession(args.session)
					: undefined;

			if (baseId) return baseId;

			const result = await sdk.session.create({ name: name() });
			return result.data?.id as string;
		}

		console.log("********************");
		console.log("messages", messages);
		console.log("dir", directory);
		console.log("files", files);
		console.log("********************");

		const agentDir = Global.Path.agent;
		console.log("agentDir", agentDir);

		async function execute(sdk: CodeWorkSdkClient) {
			console.log("***** sdk ****");
			const sessionId = await session(sdk);
			console.log("************** sessionId: ************", sessionId);
		}

		await bootstrap(process.cwd(), async () => {
			const fetchFn = (async (...fetchArgs: Parameters<typeof globalThis.fetch>) => {
				const request = new Request(...fetchArgs);
				return Server.LocalApp().fetch(request);
			}) as typeof globalThis.fetch;
			const sdk = createCodeWorkClient({ baseUrl: "http://codework.internal", fetch: fetchFn });
			await execute(sdk);
		});
	},
});
