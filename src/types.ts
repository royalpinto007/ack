export type Network = "localnet" | "devnet";
export type ReceiptStatus = "created" | "delivered" | "acknowledged";

export interface ReceiptView {
  address: string;
  version: number;
  requestHash: string;
  provider: string;
  client: string;
  responseHash: string | null;
  createdAt: number;
  deliveredAt: number | null;
  acknowledgedAt: number | null;
  status: ReceiptStatus;
}

export interface ReceiptSnapshot {
  network: Network;
  programId: string;
  observedAt: string;
  receipts: ReceiptView[];
}

export interface ApiError {
  error: { code: string; message: string };
}
