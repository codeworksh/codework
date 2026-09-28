// Separate entry so this module runs before the (heavier) React tree mounts.
void import("./main").catch((error: unknown) => {
	console.error(error);
});
