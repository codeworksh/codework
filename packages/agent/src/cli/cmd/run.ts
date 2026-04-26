import type { Argv, ArgumentsCamelCase } from "yargs";
import { cmd } from "./cmd.ts";
import path from "node:path";
import { Filesystem } from "@codeworksh/utils";
import { UI } from "../ui.ts";
import { pathToFileURL } from "node:url";

interface RunArgs extends ArgumentsCamelCase {
  args: string[];
  title?: string;
  dir?: string;
  provider?: string;
  model?: string;
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
      });
  },
  handler: async (args: RunArgs) => {
    const allArgs = [...args.args, ...(args["--"] || [])];
    const fileArgs = allArgs
      .filter((s) => s.startsWith("@"))
      .map((s) => s.slice(1));
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

        const mime = (await Filesystem.isDir(resolvedPath))
          ? "application/x-directory"
          : "text/plain";

        files.push({
          type: "file",
          url: pathToFileURL(resolvedPath).href,
          filename: path.basename(resolvedPath),
          mime,
        });
      }
    }

    console.log("messages", messages);
    console.log("dir", directory);
    console.log("files", files);
  },
});
