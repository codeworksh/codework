import { Agent } from "./agent/agent";
import { Loop } from "./agent/loop";

type AgentFacade = {
	create: typeof Agent.create;
	loop: typeof Loop.run;
	loopContinue: typeof Loop.runContinue;
};

export const agent = {
	create: Agent.create,
	loop: Loop.run,
	loopContinue: Loop.runContinue,
} as AgentFacade;
