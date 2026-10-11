import { Effect } from "effect";
import { Runtime } from "../../../../framework/runtime.ts";
import { Discovery } from "../../../../server/discovery.ts";
import { reportFailure } from "../../../error.ts";
import { writeOut } from "../../../output.ts";
import { Service } from "../../../service.ts";
import { Cmd } from "../../cmd.ts";

export default Runtime.handler(
	Cmd.commands.service.commands.restart,
	Effect.fn("CLI.service.restart")(function* ({ host, port }) {
		const options = yield* Service.options(yield* Cmd.spec, { host, port });
		yield* Discovery.stop(options.home);
		const server = yield* Discovery.ensure({ ...options, replace: true });
		yield* writeOut(`${server.url}\n`);
	}, Effect.catch(reportFailure)),
);
