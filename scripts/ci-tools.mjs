import { createHash } from "node:crypto";
import { mkdir, writeFile, chmod, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// CI-only tool bootstrap. Normal users install the versions linked in README.
if (!process.env.CI || process.platform !== "linux" || process.arch !== "x64")
  throw new Error("This bootstrap is for Linux x64 CI only.");
const root = join(process.env.RUNNER_TEMP ?? process.cwd(), "ack-toolchain");
await mkdir(root, { recursive: true });
const artifacts = [
  [
    "anchor",
    "https://github.com/otter-sec/anchor/releases/download/v1.2.1/anchor-1.2.1-x86_64-unknown-linux-gnu",
    "5c899379cbd9a843fa4a730a37ba7ab61357571ffc535036a9afa08e5cd0b99b",
  ],
  [
    "solana.tar.bz2",
    "https://github.com/anza-xyz/agave/releases/download/v4.1.2/solana-release-x86_64-unknown-linux-gnu.tar.bz2",
    "5991d027a686eb419a709a479178b33eb83501e8a2bfbf599a81a286bfcbf770",
  ],
];
for (const [name, url, digest] of artifacts) {
  const path = join(root, name);
  execFileSync(
    "curl",
    [
      "--fail",
      "--location",
      "--retry",
      "3",
      "--silent",
      "--show-error",
      "--output",
      path,
      url,
    ],
    { stdio: "inherit" },
  );
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== digest)
    throw new Error(`Checksum mismatch for ${name}`);
}
await chmod(join(root, "anchor"), 0o755);
execFileSync("tar", ["-xjf", join(root, "solana.tar.bz2"), "-C", root], {
  stdio: "inherit",
});
await writeFile(
  process.env.GITHUB_PATH,
  `${root}\n${join(root, "solana-release/bin")}\n`,
  { flag: "a" },
);
