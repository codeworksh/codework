// Separate entry so this module runs before the (heavier) React tree mounts.
void import("./main")
	.then(({ startup }) => startup)
	.catch((error: unknown) => {
		console.error(error);
		// The app never mounted, so the splash is still up: it turns into the failure and a way out.
		const shell = document.getElementById("boot-shell");
		if (shell === null) return;
		const message = document.createElement("p");
		message.textContent = "CodeWork could not load.";
		const reload = document.createElement("button");
		reload.type = "button";
		reload.textContent = "Reload";
		reload.addEventListener("click", () => window.location.reload());
		shell.replaceChildren(message, reload);
	});
