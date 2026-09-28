import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: IndexView,
});

function IndexView() {
	return <div>Hello, world</div>;
}
