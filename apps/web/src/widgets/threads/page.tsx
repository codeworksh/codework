import { ThreadsIcon } from "@/components/vuesax";
import { Page } from "../../shell/page";
import { AllThreads } from "./threads";

/** Threads as a page of its own; its display options are kept under the page's own instance. */
export function ThreadsPage() {
	return (
		<Page instanceId="page" title="Threads" icon={ThreadsIcon}>
			<AllThreads instanceId="page" props={{}} address={undefined} params={{}} />
		</Page>
	);
}
