import { getAddress } from "viem";
import { TransactionBundleStatus } from "@skandha/types/lib/executor";
import { now } from "../utils";
import { ITransactionBundleEntry } from "./interfaces";

export interface TransactionBundleEntrySerialized {
  chainId: number;
  bundleHash: string;
  tx1Hash: string;
  tx2Hash: string;
  builderAddress: string;
  signedTx1: string;
  status: TransactionBundleStatus;
  submittedTime: number;
  lastUpdatedTime: number;
  submitAttempts: number;
  revertReason?: string;
  maxBlock?: string; // Serialized as string for storage
}

export class TransactionBundleEntry implements ITransactionBundleEntry {
  chainId: number;
  bundleHash: string;
  tx1Hash: string;
  tx2Hash: string;
  builderAddress: string;
  signedTx1: string;
  status: TransactionBundleStatus;
  submittedTime: number;
  lastUpdatedTime: number;
  submitAttempts: number;
  revertReason?: string;
  maxBlock?: bigint;

  constructor({
    chainId,
    bundleHash,
    tx1Hash,
    tx2Hash,
    builderAddress,
    signedTx1,
    status,
    submittedTime,
    lastUpdatedTime,
    submitAttempts,
    revertReason,
    maxBlock,
  }: {
    chainId: number;
    bundleHash: string;
    tx1Hash: string;
    tx2Hash: string;
    builderAddress: string;
    signedTx1: string;
    status?: TransactionBundleStatus;
    submittedTime?: number;
    lastUpdatedTime?: number;
    submitAttempts?: number;
    revertReason?: string;
    maxBlock?: bigint | string; // Accept string for deserialization
  }) {
    this.chainId = chainId;
    this.bundleHash = bundleHash;
    this.tx1Hash = tx1Hash;
    this.tx2Hash = tx2Hash;
    this.builderAddress = getAddress(builderAddress);
    this.signedTx1 = signedTx1;
    this.status = status ?? TransactionBundleStatus.New;
    this.submittedTime = submittedTime ?? now();
    this.lastUpdatedTime = lastUpdatedTime ?? now();
    this.submitAttempts = submitAttempts ?? 0;
    this.revertReason = revertReason;
    // Handle maxBlock conversion from string (for deserialization) or bigint
    this.maxBlock = typeof maxBlock === "string" ? BigInt(maxBlock) : maxBlock;
  }

  /**
   * Set status of a bundle entry
   */
  setStatus(
    status: TransactionBundleStatus,
    params?: {
      bundleHash?: string;
      revertReason?: string;
    }
  ): void {
    this.status = status;
    this.lastUpdatedTime = now();
    switch (status) {
      case TransactionBundleStatus.Pending: {
        if (params?.bundleHash) {
          this.bundleHash = params.bundleHash;
        }
        break;
      }
      case TransactionBundleStatus.Submitted: {
        if (params?.bundleHash) {
          this.bundleHash = params.bundleHash;
        }
        break;
      }
      case TransactionBundleStatus.OnChain: {
        // No need to update bundleHash, it's already set
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
      signedTx1: this.signedTx1,
      status: this.status,
      submittedTime: this.submittedTime,
      lastUpdatedTime: this.lastUpdatedTime,
      submitAttempts: this.submitAttempts,
      revertReason: this.revertReason,
      maxBlock: this.maxBlock?.toString(),
    };
  }
}

