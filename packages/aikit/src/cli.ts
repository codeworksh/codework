#!/usr/bin/env node
import pkg from "../package.json" with { type: "json" };
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { ModelgenCommand } from "./cli/modelgen";
import { OAuthCommand } from "./cli/oauth";

const cli = yargs(hideBin(process.argv))
	.scriptName("aikit")
	.wrap(100)
	.help("help", "show help")
	.alias("help", "h")
	.version("version", "show version number", pkg.version)
	.alias("version", "v")
	.command(ModelgenCommand)
	.command(OAuthCommand)
	.demandCommand(1, "Choose a command")
	.strict()
	.fail((message, error) => {
		if (error) throw error;
		if (message) throw new Error(message);
	});

try {
	await cli.parse();
} catch (error) {
	process.exitCode = 1;
	console.error(error instanceof Error ? error.message : String(error));
}
