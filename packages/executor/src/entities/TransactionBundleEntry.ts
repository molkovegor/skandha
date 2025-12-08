import { getAddress } from "viem";
import { TransactionBundleStatus } from "@skandha/types/lib/executor";
import { now } from "../utils";

export interface ITransactionBundleEntry {
  chainId: number;
  bundleHash: string;
  tx1Hash: string;
  tx2Hash: string;
  builderAddress: string;
  status: TransactionBundleStatus;
  transaction?: string;
  submittedTime: number;
  lastUpdatedTime: number;
  submitAttempts: number;
  revertReason?: string;
}

export interface TransactionBundleEntrySerialized {
  chainId: number;
  bundleHash: string;
  tx1Hash: string;
  tx2Hash: string;
  builderAddress: string;
  status: TransactionBundleStatus;
  transaction?: string;
  submittedTime: number;
  lastUpdatedTime: number;
  submitAttempts: number;
  revertReason?: string;
}

export class TransactionBundleEntry implements ITransactionBundleEntry {
  chainId: number;
  bundleHash: string;
  tx1Hash: string;
  tx2Hash: string;
  builderAddress: string;
  status: TransactionBundleStatus;
  transaction?: string;
  submittedTime: number;
  lastUpdatedTime: number;
  submitAttempts: number;
  revertReason?: string;

  constructor({
    chainId,
    bundleHash,
    tx1Hash,
    tx2Hash,
    builderAddress,
    status,
    transaction,
    submittedTime,
    lastUpdatedTime,
    submitAttempts,
    revertReason,
  }: {
    chainId: number;
    bundleHash: string;
    tx1Hash: string;
    tx2Hash: string;
    builderAddress: string;
    status?: TransactionBundleStatus;
    transaction?: string;
    submittedTime?: number;
    lastUpdatedTime?: number;
    submitAttempts?: number;
    revertReason?: string;
  }) {
    this.chainId = chainId;
    this.bundleHash = bundleHash;
    this.tx1Hash = tx1Hash;
    this.tx2Hash = tx2Hash;
    this.builderAddress = getAddress(builderAddress);
    this.status = status ?? TransactionBundleStatus.New;
    this.transaction = transaction;
    this.submittedTime = submittedTime ?? now();
    this.lastUpdatedTime = lastUpdatedTime ?? now();
    this.submitAttempts = submitAttempts ?? 0;
    this.revertReason = revertReason;
  }

  /**
   * Set status of a bundle entry
   */
  setStatus(
    status: TransactionBundleStatus,
    params?: {
      transaction?: string;
      revertReason?: string;
    }
  ): void {
    this.status = status;
    this.lastUpdatedTime = now();
    switch (status) {
      case TransactionBundleStatus.Pending: {
        this.transaction = params?.transaction;
        break;
      }
      case TransactionBundleStatus.Submitted: {
        this.transaction = params?.transaction;
        break;
      }
      case TransactionBundleStatus.OnChain: {
        this.transaction = params?.transaction;
        break;
      }
      case TransactionBundleStatus.Reverted: {
        this.revertReason = params?.revertReason;
        break;
      }
      default: {
        // nothing
      }
    }
  }

  serialize(): TransactionBundleEntrySerialized {
    return {
      chainId: this.chainId,
      bundleHash: this.bundleHash,
      tx1Hash: this.tx1Hash,
      tx2Hash: this.tx2Hash,
      builderAddress: this.builderAddress,
      status: this.status,
      transaction: this.transaction,
      submittedTime: this.submittedTime,
      lastUpdatedTime: this.lastUpdatedTime,
      submitAttempts: this.submitAttempts,
      revertReason: this.revertReason,
    };
  }
}

