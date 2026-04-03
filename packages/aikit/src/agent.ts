import { Loop } from "./agent/loop";

type Agent = {
	run: typeof Loop.run;
	runContinue: typeof Loop.runContinue;
};

export const agent = {
	run: Loop.run,
	runContinue: Loop.runContinue,
} as Agent;
