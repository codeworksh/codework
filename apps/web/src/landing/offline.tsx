import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { Play, RotateCw, Settings } from "lucide-react";
import type { ReactNode } from "react";

import { serversAtom, useServerAction } from "../settings/servers/local";
import { projectsAtom } from "../widgets/session/projects";
import { Empty, EmptyAction } from "./empty";

/**
 * What the sidebar shows when sessions cannot load, from the default server's own state: what is
 * wrong in a few words, and the one thing that fixes it, so the list loads in place once it does.
 */
export function ServerOffline() {
	const servers = useAtomValue(serversAtom);
	const refreshProjects = useAtomRefresh(projectsAtom);
	const navigate = useNavigate();
	const { running, error, act } = useServerAction();
	const server = AsyncResult.isSuccess(servers) ? servers.value.find((candidate) => candidate.isDefault) : undefined;
	const settings = () => void navigate({ to: "/settings/servers" });
	const settingsLink = (
		<button
			type="button"
			onClick={settings}
			className="text-[11px] text-ink-muted/70 underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:underline"
		>
			Server Settings
		</button>
	);

	// Asks the server, then loads the list again once it is up.
	const run = (action: "start" | "restart") => {
		if (server === undefined) return;
		void act(server.id, action).then((done) => done && refreshProjects());
	};

	if (server === undefined)
		return (
			<Message title="Connecting…" line="Looking for the CodeWork server.">
				{AsyncResult.isFailure(servers) && settingsLink}
			</Message>
		);

	const { cli } = server;
	if (cli === null)
		return (
			<Message
				title="CodeWork Isn't Installed"
				line="Install it, or point to it, to see your projects and sessions."
			>
				<EmptyAction icon={<Settings className="-mx-0.5 size-3" strokeWidth={2} aria-hidden />} onClick={settings}>
					Set Up
				</EmptyAction>
			</Message>
		);
	if ("failure" in cli)
		return (
			<Message title="CodeWork Won't Start" line={`The codework executable for ${server.name} fails to run.`}>
				<EmptyAction icon={<Settings className="-mx-0.5 size-3" strokeWidth={2} aria-hidden />} onClick={settings}>
					Server Settings
				</EmptyAction>
			</Message>
		);

	switch (server.server._tag) {
		case "Stopped":
			return (
				<Message title="Server Not Running" line={`${server.name} isn't running, so your projects can't load.`}>
					<EmptyAction
						icon={<Play className="-mx-0.5 size-3" strokeWidth={2} aria-hidden />}
						disabled={running !== null}
						onClick={() => run("start")}
					>
						{running === "start" ? "Starting…" : "Start Server"}
					</EmptyAction>
					{error !== null && <Failure message={error} />}
					{settingsLink}
				</Message>
			);
		case "Unreachable":
			return (
				<Message title="Server Not Answering" line={`${server.name} is registered but doesn't reply.`}>
					<EmptyAction
						icon={<RotateCw className="-mx-0.5 size-3" strokeWidth={2} aria-hidden />}
						disabled={running !== null}
						onClick={() => run("restart")}
					>
						{running === "restart" ? "Restarting…" : "Restart"}
					</EmptyAction>
					{error !== null && <Failure message={error} />}
					{settingsLink}
				</Message>
			);
		case "Incompatible":
			return (
				<Message
					title="Server Is Another Build"
					line={`${server.name} runs codework v${server.server.version}, which this app can't read.`}
				>
					<EmptyAction
						icon={<Settings className="-mx-0.5 size-3" strokeWidth={2} aria-hidden />}
						onClick={settings}
					>
						Server Settings
					</EmptyAction>
				</Message>
			);
		case "Running":
			return (
				<Message title="Could Not Load Sessions" line={`${server.name} is running but the list didn't load.`}>
					<EmptyAction
						icon={<RotateCw className="-mx-0.5 size-3" strokeWidth={2} aria-hidden />}
						onClick={() => refreshProjects()}
					>
						Try Again
					</EmptyAction>
				</Message>
			);
	}
}

function Message({ title, line, children }: { title: string; line: string; children?: ReactNode }) {
	return (
		<Empty>
			<span className="text-ink-muted">{title}</span>
			<span className="max-w-56 text-balance">{line}</span>
			<span className="mt-1 flex flex-col items-center gap-2">{children}</span>
		</Empty>
	);
}

const Failure = ({ message }: { message: string }) => (
	<span className="max-w-56 text-balance text-destructive/80">{message}</span>
);
