import { registerProtocolProvider } from "../protocol";
import anthropicMessages from "../protocols/anthropic-messages";

// register
registerProtocolProvider(anthropicMessages);
