import { UserOperation } from "@skandha/types/lib/contracts/UserOperation";
import {
  MempoolEntryStatus,
  ReputationStatus,
  TransactionBundleStatus,
} from "@skandha/types/lib/executor";

type BigNumberish = bigint | number | `0x${string}` | `${number}` | string;

export interface IMempoolEntry {
  chainId: number;
  userOp: UserOperation;
  entryPoint: string;
  prefund: BigNumberish;
  aggregator?: string;
  factory?: string;
  paymaster?: string;
  userOpHash: string;
  lastUpdatedTime: number;
  hash?: string;
  status: MempoolEntryStatus;
  transaction?: string;
  submitAttempts: number;
  submittedTime?: number;
  actualTransaction?: string;
  revertReason?: string;
}

export interface MempoolEntrySerialized {
  chainId: number;
  userOp: UserOperation;
  prefund: string;
  aggregator: string | undefined;
  factory: string | undefined;
  paymaster: string | undefined;
  userOpHash: string;
  hash: string | undefined;
  lastUpdatedTime: number;
  transaction: string | undefined;
  submitAttempts: number;
  status: MempoolEntryStatus;
  submittedTime?: number;
  actualTransaction: string | undefined;
  revertReason: string | undefined;
}

export interface IReputationEntry {
  chainId: number;
  address: string;
  opsSeen: number;
  opsIncluded: number;
  lastUpdateTime: number;
}

export type ReputationEntryDump = Omit<
  IReputationEntry,
  "chainId" | "lastUpdateTime"
> & { status: ReputationStatus };

export type ReputationEntrySerialized = Omit<
  IReputationEntry,
  "address" | "chainId"
>;

export interface ITransactionBundleEntry {
  chainId: number;
  bundleHash: string;
  tx1Hash: string;
  tx2Hash: string;
  builderAddress: string;
  signedTx1: string; // Store the signed transaction for later submission
  status: TransactionBundleStatus;
  submittedTime: number;
  lastUpdatedTime: number;
  submitAttempts: number;
  revertReason?: string;
  maxBlock?: bigint; // Maximum block number for bundle inclusion
}
