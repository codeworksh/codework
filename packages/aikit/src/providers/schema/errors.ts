import { NamedError } from "@codeworksh/utils";
import Type from "typebox";

export const ProtocolAuthError = NamedError.create(
  "ProtocolAuthError",
  Type.Object({
    message: Type.String(),
    protocol: Type.String(),
  }),
);
export type ProtocolAuthError = InstanceType<typeof ProtocolAuthError>;
