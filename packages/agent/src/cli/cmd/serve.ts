import { Server } from "../../server/server";
import { cmd } from "./cmd";
import { withNetworkOptions, resolveNetworkOptions } from "../network";

const shutdownSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function waitForShutdownSignal() {
	return new Promise<void>((resolve) => {
		const onSignal = () => {
			for (const signal of shutdownSignals) {
				process.off(signal, onSignal);
			}
			resolve();
		};

		for (const signal of shutdownSignals) {
			process.on(signal, onSignal);
		}
	});
}

export const ServeCommand = cmd({
	command: "serve",
	builder: (yargs) => withNetworkOptions(yargs),
	describe: "starts a headless codework server",
	handler: async (args) => {
		const opts = await resolveNetworkOptions(args);
		const server = await Server.listen(opts);
		console.log(`codework server listening on ${server.url}`);

		try {
			await waitForShutdownSignal();
		} finally {
			await server.close();
		}
	},
});
