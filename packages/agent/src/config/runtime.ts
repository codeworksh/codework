import path from "node:path";
import { Global } from "./global";
import { WorkspaceContext } from "../workspace/context";

export namespace Runtime {
	function activeSandbox() {
		try {
			return WorkspaceContext.sandbox;
		} catch {
			return undefined;
		}
	}

	export async function agentDir(cwd?: string): Promise<string | undefined> {
		const sandbox = activeSandbox();
		if (!sandbox) return Global.Path.agent;

		const base = cwd ?? sandbox.cwd;
		const dir = sandbox.resolvePath(path.join(base, ".codework", "agent"));
		const stat = await sandbox.stat(dir).catch(() => undefined);
		if (!stat?.isDirectory) return undefined;
		return dir;
	}
}
