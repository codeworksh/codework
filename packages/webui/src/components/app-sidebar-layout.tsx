import { Link } from "@tanstack/react-router";
import {
  BoxesIcon,
  CommandIcon,
  HomeIcon,
  MenuIcon,
  PanelLeftIcon,
} from "lucide-react";
import { type ReactNode } from "react";

import { APP_DISPLAY_NAME } from "../branding";
import { isElectron } from "../env";
import { useCommandPaletteStore } from "../lib/cmd-palette-store";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

const navigationItems = [
  { icon: HomeIcon, label: "Home", to: "/" },
  { icon: BoxesIcon, label: "Concepts", to: "/concepts" },
] as const;

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delay={250}>
      <div className="app-sidebar-layout flex h-screen w-screen overflow-hidden bg-background text-foreground">
        <aside className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
          <SidebarContent />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className={cn(
              "app-mobile-header flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 md:hidden",
              isElectron &&
                "drag-region h-[52px] pl-[90px] wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)] wco:pl-[calc(env(titlebar-area-x)+1em)]",
            )}
          >
            <MobileSidebar />
            <div className="min-w-0 flex-1 truncate text-sm font-medium">
              {APP_DISPLAY_NAME}
            </div>
            <CommandPaletteButton />
          </header>

          <main className="min-h-0 flex-1 overflow-auto">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}

function SidebarContent() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "app-sidebar-desktop-header flex h-12 items-center gap-2 px-3",
          isElectron && "drag-region h-[52px] pl-[90px] wco:h-[env(titlebar-area-height)] wco:pl-[calc(env(titlebar-area-x)+1em)]",
        )}
      >
        {/* <div className="flex size-7 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
          <PanelLeftIcon className="size-3.5" />
        </div> */}
        {/* <div className="min-w-0">
          <div className="truncate text-sm font-semibold">
            {APP_DISPLAY_NAME}
          </div>
          <div className="text-[0.6875rem] text-muted-foreground">
            Workspace shell
          </div>
        </div> */}
      </div>

      <Separator />

      <nav className="flex flex-1 flex-col gap-1 p-2">
        {navigationItems.map((item) => (
          <Link
            activeProps={{
              className: "bg-sidebar-accent text-sidebar-accent-foreground",
            }}
            className="flex h-8 items-center gap-2 rounded-md px-2 text-xs/relaxed text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            key={item.to}
            to={item.to}
          >
            <item.icon className="size-3.5" />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      <div className="border-t border-sidebar-border p-2">
        <CommandPaletteButton expanded />
      </div>
    </div>
  );
}

function MobileSidebar() {
  return (
    <Sheet>
      <SheetTrigger
        render={
          <Button aria-label="Open navigation" size="icon" variant="ghost" />
        }
      >
        <MenuIcon />
      </SheetTrigger>
      <SheetContent className="w-72 p-0" side="left">
        <SheetHeader className="sr-only">
          <SheetTitle>{APP_DISPLAY_NAME}</SheetTitle>
          <SheetDescription>Application navigation</SheetDescription>
        </SheetHeader>
        <SidebarContent />
      </SheetContent>
    </Sheet>
  );
}

function CommandPaletteButton({ expanded = false }: { expanded?: boolean }) {
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const button = (
    <Button
      aria-label="Open command palette"
      className={expanded ? "w-full justify-start" : undefined}
      onClick={() => setOpen(true)}
      size={expanded ? "default" : "icon"}
      variant="ghost"
    >
      <CommandIcon />
      {expanded ? (
        <>
          <span>Command palette</span>
          <span className="ml-auto text-[0.625rem] text-muted-foreground">
            Cmd K
          </span>
        </>
      ) : null}
    </Button>
  );

  if (expanded) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>Command palette</TooltipContent>
    </Tooltip>
  );
}
