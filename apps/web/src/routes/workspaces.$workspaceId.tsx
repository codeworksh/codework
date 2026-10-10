import { createFileRoute } from "@tanstack/react-router";

// The root Shell renders the workspace; an unknown id falls back to the first one.
export const Route = createFileRoute("/workspaces/$workspaceId")({});
