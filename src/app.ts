import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import { fileURLToPath } from "node:url";
import {
  ReceiptClient,
  ReceiptNotFoundError,
  ReceiptStateError,
  validatePublicKey,
} from "./client/index.js";

export function createApp(client = new ReceiptClient()) {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
      strictTransportSecurity: false,
    }),
  );
  app.use((req, res, next) => {
    const host = req.headers.host ?? "";
    if (
      !/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host) ||
      (req.headers.origin && req.headers.origin !== `http://${host}`) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      res.status(403).json({
        error: {
          code: "LOCAL_ACCESS_ONLY",
          message: "Open ack? directly through its localhost address.",
        },
      });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    if (
      req.path.startsWith("/api/") &&
      req.method !== "GET" &&
      req.method !== "HEAD"
    ) {
      res.status(405).setHeader("Allow", "GET, HEAD");
      res.json({
        error: {
          code: "READ_ONLY",
          message:
            "The dashboard is read-only. Use the CLI to sign transactions.",
        },
      });
      return;
    }
    next();
  });
  app.get("/api/health", (_req, res) =>
    res.json({
      status: "ok",
      mode: "read-only",
      network: client.network,
      programId: client.programId.toBase58(),
    }),
  );
  let inFlight = 0,
    windowStart = Date.now(),
    reads = 0;
  app.use("/api/receipts", (_req, res, next) => {
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now();
      reads = 0;
    }
    if (reads >= 60 || inFlight >= 2) {
      res.status(429).setHeader("Retry-After", "10");
      res.json({
        error: {
          code: "LOOKUP_LIMIT",
          message: "Wait before refreshing receipts again.",
        },
      });
      return;
    }
    reads++;
    next();
  });
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    inFlight++;
    try {
      return await operation();
    } finally {
      inFlight--;
    }
  };
  const metadata = () => ({
    network: client.network,
    programId: client.programId.toBase58(),
    observedAt: new Date().toISOString(),
  });
  app.get("/api/receipts", async (_req, res) => {
    const receipts = await read(() => client.list());
    res.json({ ...metadata(), receipts });
  });
  const detail =
    (download: boolean): express.RequestHandler =>
    async (req, res) => {
      let address;
      try {
        address = validatePublicKey(String(req.params.address));
      } catch {
        res.status(400).json({
          error: {
            code: "INVALID_ADDRESS",
            message: "Enter a valid receipt PDA address.",
          },
        });
        return;
      }
      const receipt = await read(() => client.inspect(address));
      if (download) res.attachment(`ack-${address.toBase58()}.json`);
      res.json({ ...metadata(), receipt });
    };
  app.get("/api/receipts/:address/export", detail(true));
  app.get("/api/receipts/:address", detail(false));
  app.use("/api", (_req, res) =>
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "API route not found." } }),
  );
  app.use(
    express.static(fileURLToPath(new URL("./public/", import.meta.url)), {
      dotfiles: "deny",
    }),
  );
  app.use((_req, res) =>
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Page not found." } }),
  );
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof ReceiptNotFoundError) {
      res
        .status(404)
        .json({ error: { code: "RECEIPT_NOT_FOUND", message: error.message } });
      return;
    }
    if (error instanceof ReceiptStateError) {
      res.status(422).json({
        error: { code: "INVALID_RECEIPT", message: error.message },
      });
      return;
    }
    res.status(502).json({
      error: {
        code: "CHAIN_UNAVAILABLE",
        message:
          "Could not read this program. Start the local demo, or check your selected network and program address.",
      },
    });
  };
  app.use(errors);
  return app;
}
