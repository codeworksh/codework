import { Machine, Relay, shellQuoted } from "@codeworksh/schema";
import { Effect, Option, Schema } from "effect";
import * as Runtime from "../../../framework/runtime.ts";
import * as MachineRelay from "../../../machine/relay.ts";
import * as Discovery from "../../../server/discovery.ts";
import { InvalidInputError, reportFailure } from "../../error.ts";
import { writeOut } from "../../output.ts";
import * as Service from "../../service.ts";
import { Cmd } from "../cmd.ts";

export default Runtime.handler(
	Cmd.commands.connect,
	Effect.fn("CLI.connect")(
		function* ({ workspace, machineId }) {
			const workspaceId = Option.getOrUndefined(workspace);
			if (workspaceId !== undefined && !Schema.is(Relay.WorkspaceId)(workspaceId)) {
				return yield* new InvalidInputError({
					message: "--workspace must be a Workspace ID; copy it from Settings → Machines in the CodeWork app",
				});
			}
			const spec = yield* Cmd.spec;
			const paths = yield* Service.home(spec);
			const connected = yield* MachineRelay.connect({
				home: paths.home,
				workspaceId,
				machineId: Option.getOrUndefined(machineId),
				onCode: (code) => writeOut(`Approve this machine in the CodeWork app with code ${code}\n`),
			});
			yield* writeOut(`Connected to ${connected.workspace.name}\n`);
			// The workspace sees a machine online while its server runs; say how when it doesn't yet.
			if ((yield* Discovery.discover(paths.home)) === undefined) {
				const home = Option.match(spec.home, {
					onNone: () => "",
					onSome: (path) => ` --home ${shellQuoted(path)}`,
				});
				yield* writeOut(`It shows online once its server runs: codework service start${home}\n`);
			}
		},
		Effect.catchReason("HttpClientError", "TransportError", (reason) =>
			Effect.fail(
				new Machine.ConnectError({
					message: `Can't reach CodeWork's servers at ${new URL(reason.request.url).origin}; check your connection, then run connect again`,
				}),
			),
		),
		Effect.provide(MachineRelay.Client.layer),
		Effect.catch(reportFailure),
	),
);
