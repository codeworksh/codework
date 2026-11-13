import { TreeStructureIcon } from "@phosphor-icons/react";
import { Page } from "../shell/page";
import { Projects } from "./projects";

/** Projects, their sessions and forks as a tree, on a page of its own. */
export function ProjectsPage() {
	return (
		<Page instanceId="projects" title="Projects" icon={TreeStructureIcon}>
			<Projects />
		</Page>
	);
}
