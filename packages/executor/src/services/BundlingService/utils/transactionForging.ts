import {
  Hex,
  LocalAccount,
  PublicClient,
  TransactionRequest,
  getAddress,
} from "viem";
import { Logger } from "@skandha/types/lib";

export interface ForgeIncentiveTransactionParams {
  builderAddress: string;
  relayerAccount: LocalAccount;
  incentiveAmount: bigint;
  maxFeePerGas: bigint;
  publicClient: PublicClient;
  logger: Logger;
}

/**
 * Forge incentive transaction (tx2) that sends ETH directly to builderAddress
 * Transaction has zero priority fee for compliant inclusion
 */
export async function forgeIncentiveTransaction(
  params: ForgeIncentiveTransactionParams
): Promise<TransactionRequest> {
  const {
    builderAddress,
    relayerAccount,
    incentiveAmount,
    maxFeePerGas,
    publicClient,
    logger,
  } = params;

  // Get relayer's next nonce
  const nonce = await publicClient.getTransactionCount({
    address: relayerAccount.address,
  });

  // Estimate gas for a simple ETH transfer
  let gasLimit: bigint;
  try {
    gasLimit = await publicClient.estimateGas({
      account: relayerAccount.address,
      to: getAddress(builderAddress) as Hex,
      value: incentiveAmount,
    });
    // Add 20% buffer
    gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
  } catch (err) {
    logger.warn(`Failed to estimate gas, using default: ${err}`);
    // Default gas limit for a simple ETH transfer
    gasLimit = BigInt(21000);
  }

  const transactionRequest: TransactionRequest = {
    to: getAddress(builderAddress) as Hex,
    value: incentiveAmount,
    type: "eip1559",
    maxFeePerGas: maxFeePerGas,
    maxPriorityFeePerGas: BigInt(0), // Zero priority fee for compliant inclusion
    gas: gasLimit,
    nonce: nonce,
  };

  logger.debug(
    `Forged incentive transaction: to=${builderAddress}, value=${incentiveAmount.toString()}, gas=${gasLimit.toString()}, nonce=${nonce}`
  );

  return transactionRequest;
}

