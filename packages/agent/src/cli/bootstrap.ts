import { InstanceBootstrap } from "../project/bootstrap.ts";
import { Instance } from "../project/instance.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { type Server } from "../server/server.ts";

export async function bootstrap<T>(initContext: Server.CodeWorkInitContext, cb: () => Promise<T>) {
	return WorkspaceContext.provide({
		workspaceId: initContext.workspaceId,
		sandbox: initContext.sandbox,
		async fn() {
			return Instance.provide({
				key: initContext.sandbox.id,
				directory: initContext.sandbox.cwd,
				init: InstanceBootstrap,
				async fn() {
					try {
						const result = await cb();
						return result;
					} finally {
						if (initContext.sandbox.ephemeral) {
							await Instance.dispose();
							await initContext.sandbox.cleanup();
						}
					}
				},
			});
		},
	});
}
