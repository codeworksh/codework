import { InstanceBootstrap } from "../project/bootstrap";
import { Instance } from "../project/instance";
import { WorkspaceContext } from "../workspace/context";
import { type Server } from "../server/server";

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
