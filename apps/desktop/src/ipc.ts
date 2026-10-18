/** Synchronous IPC: the renderer reads the app server's RPC URL once, at load. */
export const SERVER_CHANNEL = "codework:server";
/** Synchronous IPC: the user's home directory, the folder a new project starts from. */
export const HOME_CHANNEL = "codework:home";
/** Invoke: opens the native folder dialog (Finder on macOS); resolves to the chosen path or null. */
export const PICK_FOLDER_CHANNEL = "codework:pick-folder";
/** Invoke: shows a file in Finder (Explorer on Windows), selected. */
export const REVEAL_CHANNEL = "codework:reveal";
