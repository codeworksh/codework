import { useUser } from "@clerk/electron/react";
import { useRef, useState } from "react";

import { messageOf } from "@/lib/utils";
import { isSignedInApp } from "../auth";
import { Group, Page, quietField, Row, SavingInput } from "./blocks";
import { EmptyState } from "./controls";

/** The signed-in account: picture, email and name, as the sign-in provider keeps them. */
export function ProfileSettings() {
	return (
		<Page title="Profile">
			{isSignedInApp ? (
				<Account />
			) : (
				<EmptyState title="Not Signed In" description="This build runs without an account" />
			)}
		</Page>
	);
}

function Account() {
	const { isLoaded, user } = useUser();
	const [error, setError] = useState<{
		readonly field: "picture" | "first" | "last";
		readonly message: string;
	} | null>(null);
	if (!isLoaded) return null;
	if (user === null || user === undefined)
		return <EmptyState title="Not Signed In" description="Sign in to edit your profile" />;
	const failed = (field: "picture" | "first" | "last") => (cause: unknown) =>
		setError({ field, message: messageOf(cause) });
	const errorOf = (field: "picture" | "first" | "last") => (error?.field === field ? error.message : undefined);
	return (
		<Group>
			<Row title="Profile Picture" description={errorOf("picture")}>
				<Picture
					url={user.imageUrl}
					onPick={(file) => {
						setError(null);
						user.setProfileImage({ file }).catch(failed("picture"));
					}}
				/>
			</Row>
			<Row title="Email">
				<span className="text-ink-secondary">{user.primaryEmailAddress?.emailAddress}</span>
			</Row>
			<Row title="First Name" description={errorOf("first")}>
				<SavingInput
					label="First name"
					value={user.firstName ?? ""}
					className={`w-full @min-[560px]:w-64 ${quietField}`}
					onCommit={(firstName) => {
						setError(null);
						user.update({ firstName }).catch(failed("first"));
					}}
				/>
			</Row>
			<Row title="Last Name" description={errorOf("last")}>
				<SavingInput
					label="Last name"
					value={user.lastName ?? ""}
					className={`w-full @min-[560px]:w-64 ${quietField}`}
					onCommit={(lastName) => {
						setError(null);
						user.update({ lastName }).catch(failed("last"));
					}}
				/>
			</Row>
		</Group>
	);
}

/** The picture as a button that picks a new image file. */
function Picture({ url, onPick }: { readonly url: string; readonly onPick: (file: File) => void }) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<button
				type="button"
				aria-label="Change profile picture"
				title="Change profile picture"
				onClick={() => input.current?.click()}
				className="size-8 shrink-0 overflow-hidden rounded-full outline-none transition-opacity duration-150 ease-out hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.96]"
			>
				<img src={url} alt="" className="size-full object-cover" />
			</button>
			<input
				ref={input}
				type="file"
				accept="image/png,image/jpeg,image/gif,image/webp"
				className="hidden"
				onChange={(event) => {
					const file = event.target.files?.[0];
					event.target.value = "";
					if (file !== undefined) onPick(file);
				}}
			/>
		</>
	);
}
