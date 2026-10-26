import { cp, readFile, writeFile } from "node:fs/promises";
import { Marked, Renderer } from "marked";
export async function buildGuide() {
  const pages = [
    { input: "guide.md", output: "guide.html", label: "Guide" },
    {
      input: "architecture.md",
      output: "architecture.html",
      label: "Architecture",
    },
    { input: "devnet.md", output: "devnet.html", label: "Devnet" },
  ];
  const links = Object.fromEntries(
    pages.map((page) => [page.input, `/${page.output}`]),
  );
  await cp("docs/architecture.svg", "dist/public/architecture.svg");
  for (const page of pages) {
    // Trusted version-controlled documentation only, never receipt data or user input.
    const marked = new Marked({
      renderer: {
        heading({ text, tokens, depth }) {
          const id = text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
          return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
        },
        link(token) {
          const [path, fragment] = token.href.split("#");
          return Renderer.prototype.link.call(this, {
            ...token,
            href: links[path]
              ? `${links[path]}${fragment ? `#${fragment}` : ""}`
              : token.href,
          });
        },
        table(token) {
          return `<div class="table-wrap">${Renderer.prototype.table.call(this, token)}</div>`;
        },
      },
    });
    const content = marked
      .parse(await readFile(`docs/${page.input}`, "utf8"))
      .replaceAll("<pre>", '<pre tabindex="0">');
    await writeFile(
      `dist/public/${page.output}`,
      `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${page.label} | ack?</title><meta name="description" content="${page.label} for ack?, signed delivery claims on Solana."/><link rel="icon" href="/favicon.svg"/><link rel="stylesheet" href="/style.css"/><link rel="stylesheet" href="/guide.css"/></head><body><a class="skip-link" href="#content">Skip to content</a><header class="app-header"><a class="brand" href="/">ack<span>?</span></a><nav aria-label="Documentation"><a href="/">Back to receipts</a>${pages.map((p) => `<a href="/${p.output}"${p === page ? ' aria-current="page"' : ""}>${p.label}</a>`).join("")}</nav></header><main class="guide-main" id="content" tabindex="-1"><article class="guide-content">${content}</article></main></body></html>`,
    );
  }
}
