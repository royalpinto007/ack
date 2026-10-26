import { z } from "zod";
import { validatePublicKey } from "./client/inputs.js";

const settings = z.object({
  PORT: z
    .string()
    .regex(/^[0-9]{1,5}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535))
    .default(4440),
  ACK_NETWORK: z.enum(["localnet", "devnet"]).default("localnet"),
  ACK_PROGRAM_ID: z.string().optional(),
});

export function readConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = settings.safeParse(environment);
  if (!parsed.success)
    throw new Error(
      "Use a PORT from 1 to 65535 and ACK_NETWORK localnet or devnet.",
    );
  if (parsed.data.ACK_PROGRAM_ID)
    validatePublicKey(parsed.data.ACK_PROGRAM_ID, "ACK_PROGRAM_ID");
  return {
    port: parsed.data.PORT,
    network: parsed.data.ACK_NETWORK,
    programId: parsed.data.ACK_PROGRAM_ID,
  };
}
