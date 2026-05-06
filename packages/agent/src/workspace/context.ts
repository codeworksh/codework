import { Context } from "../util/context";
import { type Sandbox } from "../sandbox/sandbox";

interface Context {
	workspaceId: string;
	sandbox: Sandbox.Env;
}

const context = Context.create<Context>("workspace");

export const WorkspaceContext = {
	async provide<R>(input: { workspaceId: string; sandbox: Sandbox.Env; fn: () => R }): Promise<R> {
		return context.provide({ workspaceId: input.workspaceId, sandbox: input.sandbox }, async () => {
			return input.fn();
		});
	},

	get workspaceId() {
		try {
			return context.use().workspaceId;
		} catch {
			return undefined;
		}
	},

	get sandbox(): Sandbox.Env {
		return context.use().sandbox;
	},
};
