import { Loop } from "./agent/loop";

type Agent = {
	loop: typeof Loop.agentLoop;
	continue: typeof Loop.agentLoopContinue;
};

export const agent = {
	loop: Loop.agentLoop,
	continue: Loop.agentLoopContinue,
} as Agent;
