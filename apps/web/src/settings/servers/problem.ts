import type { ServerStatus } from "@codeworksh/contract";
import { useNavigate } from "@tanstack/react-router";
import { type LucideIcon, Play, RotateCw, Settings } from "lucide-react";

import { useServerAction } from "./local";

/** Why the default server can't serve the app, and the one thing that fixes it. */
export interface Problem {
	readonly title: string;
	/** A sentence naming the server, for where there is room. */
	readonly line: string;
	/** The one fact worth a second line where there is little room. */
	readonly detail?: string;
	readonly fix: "start" | "restart" | "settings";
	readonly label: string;
}

/** The default server's problem from its status; undefined while it runs. */
export function problemOf(status: ServerStatus): Problem | undefined {
	const { cli, server } = status;
	if (cli === null)
		return {
			title: "CodeWork Isn't Installed",
			line: "Install it, or point to it, to see your projects and sessions.",
			fix: "settings",
			label: "Set Up",
		};
	if ("failure" in cli)
		return {
			title: "CodeWork Won't Start",
			line: `The codework executable for ${status.name} fails to run.`,
			fix: "settings",
			label: "Server Settings",
		};
	switch (server._tag) {
		case "Stopped":
			return {
				title: "Server Not Running",
				line: `${status.name} isn't running, so your projects can't load.`,
				fix: "start",
				label: "Start Server",
			};
		case "Unreachable":
			return {
				title: "Server Not Answering",
				line: `${status.name} is registered but doesn't reply.`,
				fix: "restart",
				label: "Restart",
			};
		case "Incompatible":
			return {
				title: "Incompatible Server Version",
				line: `${status.name} runs codework v${server.version}, which this app can't read.`,
				detail: `v${server.version}`,
				fix: "settings",
				label: "Server Settings",
			};
		case "Running":
			return undefined;
	}
}

export const fixIcons: Record<Problem["fix"], LucideIcon> = { start: Play, restart: RotateCw, settings: Settings };

/**
 * Runs a problem's fix: starts or restarts the server, or opens its settings. `onFixed` runs once
 * the server is up, so the caller can load again what failed.
 */
export function useFix(onFixed: () => void) {
	const navigate = useNavigate();
	const { running, error, act } = useServerAction();
	const run = (status: ServerStatus, problem: Problem) => {
		if (problem.fix === "settings") return void navigate({ to: "/settings/servers" });
		void act(status.id, problem.fix).then((done) => done && onFixed());
	};
	const label = (problem: Problem) =>
		running === "start" ? "Starting…" : running === "restart" ? "Restarting…" : problem.label;
	return { running: running !== null, error, run, label };
}
