import Type from "typebox";
import { NamedError } from "@codeworksh/utils";

export const ProtocolProviderNotFoundError = NamedError.create(
  "ProtocolProviderNotFoundError",
  Type.Object({
    protocol: Type.String(),
  }),
);
export type ProtocolProviderNotFoundError = InstanceType<
  typeof ProtocolProviderNotFoundError
>;
