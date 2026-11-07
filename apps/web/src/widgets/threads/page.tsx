import { ThreadsIcon } from "@/components/vuesax";
import { Page } from "../../shell/page";
import { AllThreads } from "./threads";

/** All Threads as a page of its own; its display options are kept under the page's own instance. */
export function ThreadsPage() {
	return (
		<Page instanceId="page" title="All Threads" icon={ThreadsIcon}>
			<AllThreads instanceId="page" props={{}} address={undefined} params={{}} />
		</Page>
	);
}
