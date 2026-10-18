import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";

import { serversAtom } from "../settings/servers/local";
import { fixIcons, problemOf, useFix } from "../settings/servers/problem";
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
	const fix = useFix(refreshProjects);
	const server = AsyncResult.isSuccess(servers) ? servers.value.find((candidate) => candidate.isDefault) : undefined;
	const settingsLink = (
		<button
			type="button"
			onClick={() => void navigate({ to: "/settings/servers" })}
			className="text-[11px] text-ink-muted/70 underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:underline"
		>
			Server Settings
		</button>
	);

	if (server === undefined)
		return (
			<Message title="Connecting…" line="Looking for the CodeWork server.">
				{AsyncResult.isFailure(servers) && settingsLink}
			</Message>
		);

	const problem = problemOf(server);
	if (problem === undefined)
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

	const Icon = fixIcons[problem.fix];
	return (
		<Message title={problem.title} line={problem.line}>
			<EmptyAction
				icon={<Icon className="-mx-0.5 size-3" strokeWidth={2} aria-hidden />}
				disabled={fix.running}
				onClick={() => fix.run(server, problem)}
			>
				{fix.label(problem)}
			</EmptyAction>
			{fix.error !== null && <Failure message={fix.error} />}
			{problem.fix !== "settings" && settingsLink}
		</Message>
	);
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
