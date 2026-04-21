import { createFileRoute } from "@tanstack/react-router";
import { APP_DISPLAY_NAME } from "../branding";

export const Route = createFileRoute("/")({
  component: HomeRoute,
});

function HomeRoute() {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-background text-foreground animate-in fade-in duration-500">
      <h1 className="text-4xl font-bold">{APP_DISPLAY_NAME}</h1>
      <p className="mt-4 text-xl text-muted-foreground">Hello World</p>
    </div>
  );
}
