import type { Daemon } from "@codeworksh/plugin/plugin";
import * as Git from "./git.ts";
import * as Skills from "./skills.ts";

/** The space daemons every space runs. Not configurable yet: no settings select or tune them. */
export const daemons: ReadonlyArray<Daemon.DaemonPlugin> = [
	Git.daemon as unknown as Daemon.DaemonPlugin,
	Skills.daemon as unknown as Daemon.DaemonPlugin,
];

/** Their events: registered with the kernel's, so the feed can describe them from boot. */
export const definitions = daemons.flatMap((daemon) => daemon.events ?? []);
