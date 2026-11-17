import { ClerkProvider, SignIn, SignUp, useAuth, useClerk } from "@clerk/electron/react";
import { type ReactNode, useEffect, useState } from "react";

import { isElectron } from "./env";
import { setSessionToken } from "./kernel/relay";
import { reveal } from "./splash";

const key: unknown = import.meta.env.CLERK_PUBLISHABLE_KEY;
const publishableKey = typeof key === "string" && key !== "" ? key : undefined;

/** Whether this app signs people in: the desktop app, built with a publishable key. */
export const isSignedInApp = isElectron && publishableKey !== undefined;

// Signing in and up live on these paths of the app's own origin. Clerk's default, its hosted Account
// Portal, cannot return to an Electron window. The app's router reads only the hash, so these paths
// never reach it; finishing returns to the root.
const SIGN_IN = "/sign-in";
const SIGN_UP = "/sign-up";
const HOME = "/#/";

/**
 * The desktop app requires a signed-in account. A browser build of the web app, or a build without a
 * publishable key, runs without one.
 */
export function Auth({ children }: { readonly children: ReactNode }) {
	// Clerk moves between sign-in, sign-up and their steps through these, so the gate re-renders.
	// The app opens at its root; Clerk's forms render only on their own paths, so it starts on sign-in.
	// The hash, which is the app's route, is kept.
	const [path, setPath] = useState(() => {
		const { pathname, hash } = window.location;
		if (!pathname.startsWith(SIGN_IN) && !pathname.startsWith(SIGN_UP)) {
			window.history.replaceState(null, "", `${SIGN_IN}${hash}`);
		}
		return window.location.pathname;
	});
	if (!isSignedInApp || publishableKey === undefined) return children;
	const navigate = (replace: boolean) => (to: string) => {
		window.history[replace ? "replaceState" : "pushState"](null, "", to);
		setPath(window.location.pathname);
	};
	return (
		<ClerkProvider
			publishableKey={publishableKey}
			signInUrl={SIGN_IN}
			signUpUrl={SIGN_UP}
			routerPush={navigate(false)}
			routerReplace={navigate(true)}
		>
			<Gate signingUp={path.startsWith(SIGN_UP)}>{children}</Gate>
		</ClerkProvider>
	);
}

function Gate({ signingUp, children }: { readonly signingUp: boolean; readonly children: ReactNode }) {
	const clerk = useClerk();
	const { isLoaded, isSignedIn, getToken } = useAuth();
	// Before the app renders, so the relay client's first call already carries the session.
	setSessionToken(getToken);
	// Clerk unreachable (offline): local work keeps running; only cloud features wait for it.
	if (clerk.status === "error") return children;
	if (!isLoaded) return null;
	return isSignedIn ? children : <SignInScreen signingUp={signingUp} />;
}

function SignInScreen({ signingUp }: { readonly signingUp: boolean }) {
	useEffect(reveal, []);
	return (
		<div className="flex h-full flex-col bg-desktop">
			<div className="h-titlebar shrink-0 [-webkit-app-region:drag]" />
			<div className="flex flex-1 items-center justify-center overflow-auto pb-titlebar">
				{signingUp ? (
					<SignUp routing="path" path={SIGN_UP} signInUrl={SIGN_IN} forceRedirectUrl={HOME} />
				) : (
					<SignIn
						routing="path"
						path={SIGN_IN}
						signUpUrl={SIGN_UP}
						forceRedirectUrl={HOME}
						signUpForceRedirectUrl={HOME}
					/>
				)}
			</div>
		</div>
	);
}
