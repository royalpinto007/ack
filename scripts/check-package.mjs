import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { output: { type: "string" } } });
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const ack = manifest.name === "ack-receipts";
const temporary = await mkdtemp(join(tmpdir(), `${manifest.name}-package-`));
let server;
let logs = "";
function npm(...args) {
  const result = spawnSync("npm", args, {
    cwd: temporary,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    result.stderr || result.error?.message || result.stdout,
  );
  return result.stdout;
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  try {
    await Promise.race([
      exited,
      setTimeout(5000, undefined, { ref: false }).then(() => {
        throw new Error("Installed CLI did not stop");
      }),
    ]);
  } finally {
    if (server.exitCode === null && server.signalCode === null)
      server.kill("SIGKILL");
  }
}
try {
  const packed = JSON.parse(
    npm("pack", process.cwd(), "--ignore-scripts", "--json"),
  )[0];
  const files = packed.files.map((file) => file.path);
  for (const required of [
    "dist/cli.js",
    "dist/server.js",
    "dist/public/index.html",
    "dist/public/app.js",
    "dist/public/guide.html",
    "dist/public/architecture.html",
    "README.md",
    "LICENSE",
    ...(ack
      ? ["idl/ack.json", "dist/public/devnet.html"]
      : ["dist/public/api.html"]),
  ]) {
    assert.ok(files.includes(required), `Missing package file: ${required}`);
  }
  for (const file of files) {
    assert.match(
      file,
      /^(dist\/|docs\/|idl\/|node_modules\/|package\.json$|README\.md$|LICENSE$|CONTRIBUTING\.md$|CHANGELOG\.md$)/,
    );
    assert.doesNotMatch(
      file,
      /(^|\/)(\.env[^/]*|\.npmrc|\.ack|target|data)(\/|$)|-keypair\.json$|\.(pem|key|mp4|webm|tgz)$/i,
    );
  }
  const tarball = join(temporary, packed.filename);
  await writeFile(join(temporary, "package.json"), '{"private":true}');
  npm(
    "install",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball,
  );
  npm("audit", "--omit=dev", "--audit-level=high");
  const cli = join(temporary, "node_modules", ".bin", manifest.name);
  const run = (args) =>
    spawnSync(cli, args, { cwd: temporary, encoding: "utf8", timeout: 5000 });
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr || help.error?.message);
  assert.match(help.stdout, ack ? /create[\s\S]*acknowledge/ : /Read-only/);
  if (ack) {
    const hash = run(["hash", "--text", "abc"]);
    assert.equal(hash.status, 0, hash.stderr);
    assert.equal(
      JSON.parse(hash.stdout).hash,
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const pda = run([
      "pda",
      "--client",
      "11111111111111111111111111111111",
      "--request-id",
      "package-smoke",
    ]);
    assert.equal(pda.status, 0, pda.stderr);
    assert.match(
      JSON.parse(pda.stdout).address,
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    );
  } else {
    const version = run(["--version"]);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), manifest.version);
  }
  const invalid = run(ack ? ["dashboard", "--port", "0"] : ["--port", "0"]);
  assert.equal(invalid.status, 1, invalid.stderr);
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  server = spawn(cli, [...(ack ? ["dashboard"] : []), "--port", String(port)], {
    cwd: temporary,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => {
      logs += chunk;
    });
  server.on("error", (error) => {
    logs += error.message;
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      assert.equal((await response.json()).mode, "read-only");
      ready = true;
      break;
    } catch {
      if (server.exitCode !== null || server.signalCode !== null) break;
      await setTimeout(100);
    }
  }
  assert.ok(ready, `Installed CLI failed to start: ${logs}`);
  for (const path of [
    "/",
    "/guide.html",
    "/architecture.html",
    "/app.js",
    "/architecture.svg",
    ack ? "/devnet.html" : "/api.html",
  ]) {
    const response = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 100, path);
  }
  if (!ack) {
    const examples = await (await fetch(`${base}/api/examples`)).json();
    assert.equal(examples.length, 3);
    const example = await (
      await fetch(`${base}/api/examples/${examples[0].id}`)
    ).json();
    assert.equal(example.source, "example");
    assert.equal(typeof example.supply.formatted, "string");
  }
  await stop();
  assert.equal(server.exitCode, 0, logs);
  if (values.output) await copyFile(tarball, resolve(values.output));
  console.log(
    `Verified ${packed.filename}: ${files.length} files, ${(packed.size / 1024).toFixed(0)} KB. Clean production install, audit, executable, dashboard and offline pages passed.`,
  );
} finally {
  await stop();
  await rm(temporary, { recursive: true, force: true });
}
