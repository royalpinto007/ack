import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { startLocalnet } from "./localnet.mjs";

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const local = await startLocalnet({ temporary: true });
try {
  if (!process.argv.includes("--lifecycle-only")) {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=1",
        "tests/program/receipts.test.ts",
      ],
      { stdio: "inherit", shell: false },
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => child.kill(signal));
    const [code] = await once(child, "exit");
    process.exitCode = code ?? 1;
  }

  if (!process.exitCode) {
    const exited = once(local.child, "exit");
    assert.equal(local.child.kill("SIGTERM"), true);
    await within(
      exited,
      10_000,
      "The local validator did not exit after SIGTERM.",
    );
    assert.equal(local.child.signalCode, "SIGTERM");
    assert.equal(local.child.exitCode, null);
    await within(
      local.stop(),
      3000,
      "Validator cleanup hung after its process had already exited from SIGTERM.",
    );
    await assert.rejects(access(local.ledger), { code: "ENOENT" });
    // Cleanup remains safe if callers invoke it again from their own finally block.
    await within(
      local.stop(),
      3000,
      "Repeated validator cleanup did not resolve.",
    );
    console.log(
      "Validator lifecycle regression passed: cleanup after SIGTERM.",
    );
  }
} finally {
  await local.stop();
}
