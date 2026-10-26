import type {
  ApiError,
  ReceiptSnapshot,
  ReceiptStatus,
  ReceiptView,
} from "../types.js";

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const list = $<HTMLUListElement>("#receipt-list");
const detail = $("#receipt-detail");
const search = $<HTMLInputElement>("#receipt-search");
const filter = $<HTMLSelectElement>("#status-filter");
const refresh = $<HTMLButtonElement>("#refresh");
const errorBanner = $("#error-banner");
const connectionState = $("#connection-state");
const notification = $("#notification");
const labels: Record<ReceiptStatus, string> = {
  created: "Created",
  delivered: "Delivered",
  acknowledged: "Acknowledged",
};

let snapshot: ReceiptSnapshot | null = null;
let selectedAddress = new URLSearchParams(location.search).get("receipt");
let pendingRead: AbortController | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
const shorten = (value: string, size = 5): string =>
  `${value.slice(0, size)}…${value.slice(-size)}`;
const icon = (name: string): string =>
  `<svg aria-hidden="true"><use href="/icons.svg#${name}" /></svg>`;
const statusBadge = (status: ReceiptStatus): string =>
  `<span class="status status-${status}">${labels[status]}</span>`;

function dateText(timestamp: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(timestamp * 1000));
}

function timeText(timestamp: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(timestamp * 1000));
}

function updateUrl(): void {
  const parameters = new URLSearchParams();
  if (search.value.trim()) parameters.set("q", search.value.trim());
  if (filter.value !== "all") parameters.set("status", filter.value);
  if (selectedAddress) parameters.set("receipt", selectedAddress);
  const query = parameters.toString();
  history.replaceState(
    null,
    "",
    `${location.pathname}${query ? `?${query}` : ""}`,
  );
}

function announce(message: string): void {
  clearTimeout(noticeTimer);
  notification.textContent = message;
  noticeTimer = setTimeout(() => {
    notification.textContent = "";
  }, 3500);
}

function copyButton(value: string, label: string): string {
  return `<button type="button" class="copy-button" data-copy="${escape(value)}" aria-label="Copy ${label}" title="Copy ${label}">${icon("copy")}</button>`;
}

function timelineStep(
  title: string,
  type: string,
  order: number,
  timestamp: number | null,
  actor: string,
  waiting: string,
): string {
  return `<li class="${type} ${timestamp !== null ? "complete" : "pending"}"><span class="timeline-step">${timestamp !== null ? icon("check") : order}</span><h3>${title}</h3><p>${timestamp !== null ? `<time datetime="${new Date(timestamp * 1000).toISOString()}">${dateText(timestamp)}<br />${timeText(timestamp)} UTC</time><span class="event-actor">${escape(shorten(actor, 4))}</span>` : waiting}</p></li>`;
}

function hashField(label: string, value: string | null): string {
  return `<div class="hash-field"><div class="hash-body"><span class="field-label">${label}</span>${value ? `<code class="hash-value">${escape(value)}</code>` : `<span class="pending-value">Waiting for the provider's signed claim</span>`}</div>${value ? copyButton(value, label.toLowerCase()) : ""}</div>`;
}

function renderDetail(receipt: ReceiptView | undefined): void {
  detail.setAttribute("aria-busy", "false");
  if (!receipt) {
    const hasReceipts = !!snapshot?.receipts.length;
    detail.innerHTML = `<div class="empty-state">${icon("document")}<h2>${hasReceipts ? "No matching receipts" : "No receipts yet"}</h2><p>${hasReceipts ? "Try another address, hash or status to find a receipt." : "Create a receipt from the CLI. It will appear here after your next chain read."}</p><a class="button" href="/guide.html#sign-a-receipt">Open the guide ${icon("arrow")}</a></div>`;
    return;
  }
  const headings: Record<ReceiptStatus, string> = {
    created: "Awaiting delivery",
    delivered: "Delivery claimed",
    acknowledged: "Both parties signed",
  };
  const descriptions: Record<ReceiptStatus, string> = {
    created:
      "The client created this receipt. The provider has not signed a delivery claim.",
    delivered:
      "The provider recorded a response hash. The client has not acknowledged it.",
    acknowledged:
      "The provider claimed delivery. The client acknowledged the receipt.",
  };
  detail.innerHTML = `<div class="detail-heading"><div><p class="receipt-reference">${icon("document")}<span title="${escape(receipt.address)}">${escape(shorten(receipt.address, 8))}</span>${copyButton(receipt.address, "receipt address")}</p><h2>${headings[receipt.status]}</h2><p class="detail-subtitle">${descriptions[receipt.status]}</p></div><a id="export-receipt" class="button" href="/api/receipts/${encodeURIComponent(receipt.address)}/export" download aria-label="Export receipt JSON">${icon("download")}<span>Export JSON</span></a></div>
    <ol class="timeline" aria-label="Receipt timeline">${timelineStep("Created", "created", 1, receipt.createdAt, receipt.client, "Waiting for creation")}${timelineStep("Delivered", "delivered", 2, receipt.deliveredAt, receipt.provider, "Awaiting provider")}${timelineStep("Acknowledged", "acknowledged", 3, receipt.acknowledgedAt, receipt.client, "Awaiting client")}</ol>
    <section class="hash-section" aria-labelledby="hashes-heading"><h3 class="details-label" id="hashes-heading">Commitments <span class="status status-${receipt.status}">${labels[receipt.status]}</span></h3>${hashField("Request hash", receipt.requestHash)}${hashField("Response hash", receipt.responseHash)}<p class="hash-note">32-byte commitments. Response content is never stored in this receipt.</p></section>
    <section class="participant-section" aria-labelledby="participants-heading"><h3 class="details-label" id="participants-heading">Participants</h3><div class="participants"><div class="participant"><div><span class="field-label">Client · creates and acknowledges</span><code>${escape(receipt.client)}</code></div>${copyButton(receipt.client, "client public key")}</div><div class="participant"><div><span class="field-label">Provider · claims delivery</span><code>${escape(receipt.provider)}</code></div>${copyButton(receipt.provider, "provider public key")}</div></div></section>`;
}

function visibleReceipts(): ReceiptView[] {
  const query = search.value.trim().toLowerCase();
  return (snapshot?.receipts ?? []).filter(
    (receipt) =>
      (filter.value === "all" || receipt.status === filter.value) &&
      (!query ||
        [
          receipt.address,
          receipt.requestHash,
          receipt.responseHash ?? "",
          receipt.client,
          receipt.provider,
        ].some((value) => value.toLowerCase().includes(query))),
  );
}

function render(): void {
  if (!snapshot) return;
  const receipts = visibleReceipts();
  if (!receipts.some((receipt) => receipt.address === selectedAddress))
    selectedAddress = receipts[0]?.address ?? null;
  $("#receipt-count").textContent = String(snapshot.receipts.length);
  list.setAttribute("aria-busy", "false");
  list.innerHTML = receipts.length
    ? receipts
        .map(
          (receipt) =>
            `<li><button type="button" class="receipt-item" data-address="${escape(receipt.address)}" aria-current="${receipt.address === selectedAddress}" aria-label="Receipt ${escape(shorten(receipt.address))}, ${labels[receipt.status]}"><span class="receipt-item-top"><span class="receipt-address">${escape(shorten(receipt.address))}</span>${statusBadge(receipt.status)}</span><span class="receipt-item-bottom"><span class="receipt-item-parties">${escape(shorten(receipt.client, 3))}${icon("arrow")}${escape(shorten(receipt.provider, 3))}</span><span>${dateText(receipt.createdAt)}</span></span></button></li>`,
        )
        .join("")
    : `<li class="list-empty">${snapshot.receipts.length ? "No receipts match your filters." : "No receipts found for this program."}</li>`;
  renderDetail(receipts.find((receipt) => receipt.address === selectedAddress));
  updateUrl();
}

async function readChain(): Promise<void> {
  pendingRead?.abort();
  const controller = new AbortController();
  pendingRead = controller;
  refresh.disabled = true;
  connectionState.textContent = "Reading chain";
  connectionState.dataset.state = "loading";
  errorBanner.hidden = true;
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch("/api/receipts", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const failure = (await response.json()) as ApiError;
      throw new Error(failure.error?.message ?? "The chain read failed.");
    }
    const next = (await response.json()) as ReceiptSnapshot;
    if (pendingRead !== controller) return;
    snapshot = next;
    render();
    connectionState.textContent = `${snapshot.network === "localnet" ? "Localnet" : "Devnet"} connected`;
    connectionState.dataset.state = "ready";
    $("#source-network").textContent =
      `Solana ${snapshot.network === "localnet" ? "Localnet" : "Devnet"}`;
    const program = $("#source-program");
    program.textContent = `Program ${snapshot.programId}`;
    program.title = snapshot.programId;
    $("#last-read").textContent =
      `Read ${timeText(new Date(snapshot.observedAt).getTime() / 1000)} UTC`;
    announce(
      `Read ${snapshot.receipts.length} ${snapshot.receipts.length === 1 ? "receipt" : "receipts"} from ${snapshot.network}.`,
    );
  } catch (error) {
    if (pendingRead !== controller) return;
    const message =
      error instanceof Error && error.name !== "AbortError"
        ? error.message
        : "The chain read timed out.";
    errorBanner.textContent = `${message} Check that your validator or Devnet RPC is available, then refresh.${snapshot ? " Showing the previous chain read." : ""}`;
    errorBanner.hidden = false;
    connectionState.textContent = snapshot
      ? "Previous read"
      : "Connection unavailable";
    connectionState.dataset.state = "error";
    if (!snapshot) {
      list.setAttribute("aria-busy", "false");
      list.innerHTML = `<li class="list-empty">Waiting for a chain connection.</li>`;
      detail.setAttribute("aria-busy", "false");
      detail.innerHTML = `<div class="empty-state">${icon("chain")}<h2>Connect to your program</h2><p>Start the local demo or check your configured program and RPC connection.</p><a class="button" href="/guide.html">Connection guide ${icon("arrow")}</a></div>`;
    }
  } finally {
    clearTimeout(timeout);
    if (pendingRead === controller) {
      refresh.disabled = false;
      pendingRead = null;
    }
  }
}

list.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>(
    "button[data-address]",
  );
  if (!button) return;
  selectedAddress = button.dataset.address ?? null;
  for (const item of list.querySelectorAll<HTMLButtonElement>(
    "button[data-address]",
  ))
    item.setAttribute(
      "aria-current",
      String(item.dataset.address === selectedAddress),
    );
  renderDetail(
    snapshot?.receipts.find((receipt) => receipt.address === selectedAddress),
  );
  updateUrl();
});

detail.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>(
    "button[data-copy]",
  );
  if (!button?.dataset.copy) return;
  if (!navigator.clipboard) {
    announce("Copy unavailable. Select and copy the value manually.");
    return;
  }
  void navigator.clipboard.writeText(button.dataset.copy).then(
    () => announce("Copied to clipboard."),
    () => announce("Copy unavailable. Select and copy the value manually."),
  );
});

search.addEventListener("input", render);
filter.addEventListener("change", render);
refresh.addEventListener("click", () => {
  void readChain();
});

const parameters = new URLSearchParams(location.search);
search.value = (parameters.get("q") ?? "").slice(0, 128);
const initialStatus = parameters.get("status");
if (
  initialStatus &&
  ["created", "delivered", "acknowledged"].includes(initialStatus)
)
  filter.value = initialStatus;
void readChain();
