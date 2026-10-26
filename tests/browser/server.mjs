import { startLocalnet, seedLocal } from "../../scripts/localnet.mjs";
import { createApp } from "../../dist/app.js";
const local = await startLocalnet({ temporary: true });
try {
  await seedLocal(local.client);
  const server = createApp(local.client).listen(4441, "127.0.0.1");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      server.closeAllConnections();
      server.close();
      void local.stop();
    });
} catch (error) {
  await local.stop();
  throw error;
}
