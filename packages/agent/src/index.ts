#!/usr/bin/env node
import { loadEnvFile } from "node:process";
import pkg from "../package.json" with { type: "json" };
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { ServeCommand } from "./cli/cmd/serve.ts";
import { RunCommand } from "./cli/cmd/run.ts";
import { UI } from "./cli/ui.ts";

process.on("SIGHUP", () => process.exit());

function loadEnvironment() {
	try {
		loadEnvFile();
		console.log("*********** process.env");
		console.log(process.env.CODEWORK_HOME_DIR);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
}

const cli = yargs(hideBin(process.argv))
	.scriptName("codework")
	.wrap(100)
	.help("help", "show help")
	.alias("help", "h")
	.version("version", "show version number", pkg.version)
	.alias("version", "v")
	.usage("\n" + UI.logo())
	.middleware(loadEnvironment, true)
	.command(ServeCommand)
	.command(RunCommand)
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
