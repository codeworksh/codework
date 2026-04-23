#!/usr/bin/env node
import pkg from "../package.json" with { type: "json" };
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { ServeCommand } from "./cli/cmd/serve.ts";

process.on("SIGHUP", () => process.exit());

const cli = yargs(hideBin(process.argv))
	.scriptName("codework")
	.wrap(100)
	.help("help", "show help")
	.alias("help", "h")
	.version("version", "show version number", pkg.version)
	.alias("version", "v")
	.command(ServeCommand)
	.fail((msg, err) => {
		if (err) throw err;
		if (msg) throw new Error(msg);
		process.exit(1);
	})
	.strict();

try {
	await cli.parse();
} catch (error) {
	process.exitCode = 1;
	console.error(error instanceof Error ? error.message : String(error));
}
