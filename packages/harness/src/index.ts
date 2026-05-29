import { Loop } from "./harness/loop";

export { Agent } from "./harness/agent";
export { CodeMode } from "./harness/codemode";
export * from "./harness/codemode/drivers/drivers";

type HarnessFacade = {
	loop: typeof Loop.run;
	loopContinue: typeof Loop.runContinue;
};

export const harness = {
	loop: Loop.run,
	loopContinue: Loop.runContinue,
} as HarnessFacade;
