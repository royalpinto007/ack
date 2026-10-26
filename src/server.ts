import { createApp } from "./app.js";
import { ReceiptClient } from "./client/index.js";
import { readConfig } from "./config.js";
try {
  const config = readConfig();
  const server = createApp(new ReceiptClient(config)).listen(
    config.port,
    "127.0.0.1",
    () =>
      console.log(
        `ack? dashboard: http://127.0.0.1:${config.port} (${config.network})`,
      ),
  );
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(
      error.code === "EADDRINUSE"
        ? "Dashboard port is already in use. Choose another PORT."
        : "Could not start the dashboard.",
    );
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      server.close();
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 3000).unref();
    });
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Could not start ack?.",
  );
  process.exitCode = 1;
}
