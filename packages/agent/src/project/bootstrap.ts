import { Log } from "../util/log.ts";
import { Instance } from "./instance.ts";

export async function InstanceBootstrap() {
	Log.Default.info("bootstrapping", { directory: Instance.directory });
}
