import { Log } from "../util/log";
import { Instance } from "./instance";

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory });
}
