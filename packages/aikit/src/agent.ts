import { Loop } from "./agent/loop";

type AgentFacade = {
	loop: typeof Loop.run;
	loopContinue: typeof Loop.runContinue;
};

export const agent = {
	loop: Loop.run,
	loopContinue: Loop.runContinue,
} as AgentFacade;
