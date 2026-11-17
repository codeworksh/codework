import { ClerkProvider, SignIn, useAuth, useClerk } from "@clerk/electron/react";
import { type ReactNode, useEffect } from "react";

import { isElectron } from "./env";
import { setSessionToken } from "./kernel/relay";
import { reveal } from "./splash";

const key: unknown = import.meta.env.CLERK_PUBLISHABLE_KEY;
const publishableKey = typeof key === "string" && key !== "" ? key : undefined;

/** Whether this app signs people in: the desktop app, built with a publishable key. */
export const isSignedInApp = isElectron && publishableKey !== undefined;

/**
 * The desktop app requires a signed-in account. A browser build of the web app, or a build without a
 * publishable key, runs without one.
 */
export function Auth({ children }: { readonly children: ReactNode }) {
	if (!isSignedInApp || publishableKey === undefined) return children;
	return (
		<ClerkProvider publishableKey={publishableKey}>
			<Gate>{children}</Gate>
		</ClerkProvider>
	);
}

function Gate({ children }: { readonly children: ReactNode }) {
	const clerk = useClerk();
	const { isLoaded, isSignedIn, getToken } = useAuth();
	// Before the app renders, so the relay client's first call already carries the session.
	setSessionToken(getToken);
	// Clerk unreachable (offline): local work keeps running; only cloud features wait for it.
	if (clerk.status === "error") return children;
	if (!isLoaded) return null;
	return isSignedIn ? children : <SignInScreen />;
}

function SignInScreen() {
	useEffect(reveal, []);
	return (
		<div className="flex h-full flex-col bg-desktop">
			<div className="h-titlebar shrink-0 [-webkit-app-region:drag]" />
			<div className="flex flex-1 items-center justify-center overflow-auto pb-titlebar">
				{/* Its steps live in the hash, as the app's router does; signing in returns to the app's root. */}
				<SignIn routing="hash" forceRedirectUrl="/#/" signUpForceRedirectUrl="/#/" />
			</div>
		</div>
	);
}
