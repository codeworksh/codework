import { Protocol } from "../protocol";
import anthropicMessages from "../protocols/anthropic-messages";

// register
Protocol.registerProtocolProvider(anthropicMessages);
