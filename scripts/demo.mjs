import { createApp } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import { seedLocal, startLocalnet } from "./localnet.mjs";
let local, server;
async function stop() {
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  await local?.stop();
}
try {
  const config = readConfig();
  if (config.network !== "localnet")
    throw new Error(
      "npm run demo only uses Localnet. Use npm start for read-only Devnet viewing.",
    );
  local = await startLocalnet();
  await seedLocal(local.client);
  server = createApp(local.client).listen(config.port, "127.0.0.1", () => {
    console.log(`ack? http://127.0.0.1:${config.port}`);
    console.log(
      "Three receipts created by signed transactions on your local validator.",
    );
    console.log(
      "Local demo signer files: .ack/client-keypair.json and .ack/provider-keypair.json",
    );
    console.log(
      "Ctrl+C stops the validator. Its local ledger is preserved between runs.",
    );
  });
  server.on("error", async () => {
    console.error("Dashboard port is in use. Choose another PORT.");
    await stop();
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void stop();
    });
} catch (error) {
  console.error(error.message);
  await stop();
  process.exitCode = 1;
}
