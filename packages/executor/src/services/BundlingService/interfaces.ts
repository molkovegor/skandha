import { WalletClient } from "viem";
import { Bundle } from "../../interfaces";

export type Relayer = WalletClient;

export interface TransactionBundleResult {
  bundleHash: string;
  tx2Hash: string;
}

export interface IRelayingMode {
  isLocked(): boolean;
  sendBundle(bundle: Bundle): Promise<void>;
  getAvailableRelayersCount(): number;
  canSubmitBundle(): Promise<boolean>;
  sendTransactionBundle(signedTx1: string, builderAddress: string): Promise<TransactionBundleResult>;
}
