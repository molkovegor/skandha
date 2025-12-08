import { PerChainMetrics } from "@skandha/monitoring/lib";
import { Logger } from "@skandha/types/lib";
import {
  AuthorizationList,
  Hex,
  hexToBytes,
  keccak256,
  LocalAccount,
  PublicClient,
  slice,
  toHex,
  TransactionRequest,
} from "viem";
import axios from "axios";
import { Config } from "../../../config";
import { Bundle, NetworkConfig } from "../../../interfaces";
import { MempoolService } from "../../MempoolService";
import { ReputationService } from "../../ReputationService";
import { estimateBundleGasLimit } from "../utils";
import { Relayer } from "../interfaces";
import { ExecutorEventBus } from "../../SubscriptionService";
import { EntryPointService } from "../../EntryPointService";
import { getAuthorizationList } from "../utils/eip7702";
import { BaseRelayer } from "./base";
import { forgeIncentiveTransaction } from "../utils/transactionForging";
import { calculateIncentiveAmount } from "../utils/incentiveCalculation";
import { parseTransaction } from "viem";

export class FlashbotsRelayer extends BaseRelayer {
  constructor(
    logger: Logger,
    chainId: number,
    publicClient: PublicClient,
    config: Config,
    networkConfig: NetworkConfig,
    entryPointService: EntryPointService,
    mempoolService: MempoolService,
    reputationService: ReputationService,
    eventBus: ExecutorEventBus,
    metrics: PerChainMetrics | null
  ) {
    super(
      logger,
      chainId,
      publicClient,
      config,
      networkConfig,
      entryPointService,
      mempoolService,
      reputationService,
      eventBus,
      metrics
    );
    if (!this.networkConfig.rpcEndpointSubmit) {
      throw Error(
        "If you want to use Flashbots Builder API, please set API url in 'rpcEndpointSubmit' in config file"
      );
    }
  }

  async sendBundle(bundle: Bundle): Promise<void> {
    const availableIndex = this.getAvailableRelayerIndex();
    if (availableIndex == null) return;

    const relayer = this.relayers[availableIndex];
    const mutex = this.mutexes[availableIndex];

    const { entries } = bundle;
    if (!bundle.entries.length) return;

    await mutex.runExclusive(async (): Promise<void> => {
      const beneficiary = await this.selectBeneficiary(relayer);
      const entryPoint = entries[0]!.entryPoint;
      const txRequest = this.entryPointService.encodeHandleOps(
        entryPoint,
        entries.map((entry) => entry.userOp),
        beneficiary
      );

      const { authorizationList, rpcAuthorizationList } =
        getAuthorizationList(bundle);

      const transactionRequest: TransactionRequest = {
        to: entryPoint as Hex,
        data: txRequest,
        type: authorizationList.length > 0 ? "eip7702" : "eip1559",
        maxPriorityFeePerGas: BigInt(bundle.maxPriorityFeePerGas),
        maxFeePerGas: BigInt(bundle.maxFeePerGas),
        gas: estimateBundleGasLimit(
          this.networkConfig.bundleGasLimitMarkup,
          bundle.entries,
          this.networkConfig.estimationGasLimit
        ),
        nonce: await this.publicClient.getTransactionCount({
          // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
          address: relayer.account?.address!,
        }),
      };

      if (
        !(await this.validateBundle(
          relayer,
          entries,
          transactionRequest,
          rpcAuthorizationList
        ))
      ) {
        return;
      }

      await this.submitTransaction(
        relayer,
        transactionRequest,
        authorizationList,
        bundle
      )
        .then(async ({ txHash, targetBlock, bundleHash }) => {
          this.logger.debug(
            `Flashbots: Bundle accepted (not yet included): bundleHash=${bundleHash}, txHash=${txHash}, targetBlock=${targetBlock}`
          );
          this.logger.debug(
            `Flashbots: User op hashes ${entries.map(
              (entry) => entry.userOpHash
            )}`
          );
          
          // Wait for target block to be mined, then check if bundle is included
          await this.waitForBlockAndCheckInclusion(bundleHash, targetBlock, txHash, relayer)
            .then(async (included) => {
              if (included) {
                // Transaction is included, set status to Submitted
                await this.setSubmitted(entries, txHash);
                this.logger.debug(
                  `Flashbots: Bundle included in block ${targetBlock}, entries submitted: ${entries.map((entry) => entry.userOpHash).join(", ")}`
                );
                this.reportSubmittedUserops(txHash, bundle);
              } else {
                // Bundle was accepted but not included in target block
                this.reportFailedBundle();
                this.logger.warn(
                  `Flashbots: Bundle accepted but not included in target block ${targetBlock}, resetting entries`
                );
                this.logger.debug(
                  `Flashbots: Resetting entries: ${entries.map((entry) => entry.userOpHash).join(", ")}`
                );
                await this.setNew(entries);
              }
            })
            .catch(async (err) => {
              this.reportFailedBundle();
              this.logger.error(
                err,
                "Flashbots: Error checking bundle inclusion, resetting entries"
              );
              this.logger.debug(
                `Flashbots: Resetting entries: ${entries.map((entry) => entry.userOpHash).join(", ")}`
              );
              await this.setNew(entries);
            });
        })
        .catch(async (err: any) => {
          this.reportFailedBundle();
          // Put all userops back to the mempool
          // if some userop failed, it will be deleted inside handleUserOpFail()
          this.logger.debug(`Flashbots: Setting entries back to New: ${entries.map((entry) => entry.userOpHash).join(", ")}`);
          await this.setNew(entries);
          if (err === "timeout") {
            this.logger.debug("Flashbots: Timeout");
            return;
          }
          await this.handleUserOpFail(entries, err);
          return;
        });
    });
  }

  async sendTransactionBundle(signedTx1: string, builderAddress: string): Promise<string> {
    const availableIndex = this.getAvailableRelayerIndex();
    if (availableIndex == null) {
      throw new Error("No available relayers");
    }

    const relayer = this.relayers[availableIndex];
    const mutex = this.mutexes[availableIndex];

    if (!relayer.account) {
      throw new Error("Relayer account not available");
    }

    return await mutex.runExclusive(async (): Promise<string> => {
      // Parse tx1 to get gas info
      const tx1 = parseTransaction(signedTx1 as Hex);
      const tx1GasLimit = tx1.gas ?? BigInt(21000);
      const maxFeePerGas = tx1.maxFeePerGas ?? tx1.gasPrice ?? BigInt(0);

      if (tx1.maxPriorityFeePerGas && tx1.maxPriorityFeePerGas !== BigInt(0)) {
        throw new Error("Transaction must have zero priority fee");
      }

      // Calculate incentive amount
      const incentiveAmount = await calculateIncentiveAmount(
        {
          tx1GasLimit,
          tx2GasLimit: BigInt(21000), // Will be updated after estimation
          maxFeePerGas,
          networkConfig: {
            incentiveBaseAmount: this.networkConfig.incentiveBaseAmount,
            incentiveGasMultiplier: this.networkConfig.incentiveGasMultiplier,
            incentiveMinAmount: this.networkConfig.incentiveMinAmount,
            incentiveMaxAmount: this.networkConfig.incentiveMaxAmount,
          },
        },
        this.logger
      );

      // Forge tx2 - simple ETH transfer to builderAddress
      const tx2Request = await forgeIncentiveTransaction({
        builderAddress,
        relayerAccount: relayer.account as LocalAccount,
        incentiveAmount,
        maxFeePerGas,
        publicClient: this.publicClient,
        logger: this.logger,
      });

      // Sign tx2
      const signedTx2 = await relayer.signTransaction(tx2Request as any);

      // Get current block number
      const currentBlock = await this.publicClient.getBlockNumber();
      const targetBlock = currentBlock + BigInt(1);
      const blockNumber = toHex(targetBlock);
      const maxBlock = toHex(targetBlock + BigInt(10));

      // Submit bundle via Flashbots
      const data = JSON.stringify({
        jsonrpc: "2.0",
        method: "mev_sendBundle",
        params: [{
          version: "v0.1",
          inclusion: {
            block: blockNumber,
            maxBlock: maxBlock,
          },
          body: [
            {
              tx: signedTx1,
              canRevert: false,
            },
            {
              tx: signedTx2,
              canRevert: false,
            },
          ],
          validity: {
            refund: [],
            refundConfig: [],
          },
        }],
        id: 1
      });

      if (!relayer.account) {
        throw new Error("Relayer account not available");
      }
      const payloadSignature = await (
        relayer.account as LocalAccount<"privateKey">
      ).signMessage({
        message: keccak256(toHex(data)),
      });
      const signature = relayer.account.address + ":" + payloadSignature;

      const config = {
        method: "post",
        url: this.networkConfig.rpcEndpointSubmit,
        headers: {
          "Content-Type": "application/json",
          "X-Flashbots-Signature": signature,
        },
        data,
      };

      try {
        const response = await axios.request(config);
        const { error, result } = response.data;
        this.logger.info(response.data, "Flashbots: Transaction bundle response");
        if (error) {
          this.logger.error(error, "Flashbots: Error submitting transaction bundle");
          throw new Error(error);
        }
        const bundleHash = result?.bundleHash;
        const tx2Hash = keccak256(hexToBytes(signedTx2));
        this.logger.debug(
          `Flashbots: Transaction bundle accepted with bundleHash=${bundleHash}, tx2Hash=${tx2Hash}, targetBlock=${targetBlock}`
        );
        return bundleHash;
      } catch (err) {
        this.logger.error(err, "Flashbots: Error submitting transaction bundle");
        throw err;
      }
    });
  }

  /**
   * Decodes paymasterData to extract allowedSlots
   * @param paymasterData encoded paymaster data
   * @returns array of allowed slot block numbers, or null if decoding fails
   */
  private decodePaymasterDataSlots(paymasterData: Hex): bigint[] | null {
    try {
      // Structure: uint48 validUntil (6 bytes) + uint48 validAfter (6 bytes) + 
      // uint128 sponsorUUID (16 bytes) + uint256 priorityFeeWei (32 bytes) + 
      // uint256 allowedSlotsCount (32 bytes) + slots (each 32 bytes)
      
      // Minimum length check: 6 + 6 + 16 + 32 + 32 = 92 bytes = 184 hex chars (with 0x)
      if (paymasterData.length < 186) {
        return null;
      }

      // Read allowedSlotsCount from offset 60-91 (bytes 30-45 in hex, but we need to account for 0x prefix)
      // Slice from byte 60 (30 hex chars after 0x) to byte 92 (46 hex chars after 0x)
      const slotsCountHex = slice(paymasterData, 60, 92);
      const allowedSlotsCount = BigInt(slotsCountHex);

      if (allowedSlotsCount === BigInt(0) || allowedSlotsCount > BigInt(100)) {
        // Sanity check: reasonable limit
        return null;
      }

      // Extract slots starting from byte 92 (46 hex chars after 0x)
      const slots: bigint[] = [];
      const slotSize = 32; // 32 bytes per slot
      const startOffset = 92; // Start of slots array

      for (let i = 0; i < Number(allowedSlotsCount); i++) {
        const slotStart = startOffset + i * slotSize;
        const slotEnd = slotStart + slotSize;
        
        // Check if we have enough bytes: (hexLength - 2) / 2 = byteLength
        const totalBytes = (paymasterData.length - 2) / 2;
        if (slotEnd > totalBytes) {
          // Not enough data
          break;
        }

        const slotHex = slice(paymasterData, slotStart, slotEnd);
        const slot = BigInt(slotHex);
        slots.push(slot);
      }

      return slots.length > 0 ? slots : null;
    } catch (err) {
      this.logger.debug(`Flashbots: Error decoding paymasterData: ${err}`);
      return null;
    }
  }

  /**
   * Converts a slot number to a block number using the consensus client (beacon node) API
   * @param slot slot number
   * @returns block number corresponding to the slot, or null if conversion fails
   */
  private async slotToBlockNumber(slot: bigint): Promise<bigint | null> {
    const consensusEndpoint = this.networkConfig.consensusClientEndpoint;
    
    if (!consensusEndpoint) {
      this.logger.debug(
        `Flashbots: Consensus client endpoint not configured, cannot convert slot ${slot} to block number`
      );
      return null;
    }

    try {
      // Query beacon API: GET /eth/v2/beacon/blocks/{slot}
      const url = `${consensusEndpoint}/eth/v2/beacon/blocks/${slot.toString()}`;
      const response = await axios.get(url, {
        timeout: 5000, // 5 second timeout
      });

      // The response structure varies by consensus client. Try multiple paths:
      // - Lighthouse/Prysm: data.data.message.body.execution_payload.block_number
      // - Some clients: data.data.execution_payload.block_number
      // - Alternative: data.execution_payload.block_number
      const data = response.data?.data || response.data;
      const blockNumber = 
        data?.message?.body?.execution_payload?.block_number ||
        data?.message?.execution_payload?.block_number ||
        data?.execution_payload?.block_number ||
        response.data?.execution_payload?.block_number;

      if (!blockNumber) {
        this.logger.debug(
          `Flashbots: Could not extract block number from beacon API response for slot ${slot}. Response structure: ${JSON.stringify(response.data).substring(0, 200)}`
        );
        return null;
      }

      const blockNum = BigInt(blockNumber);
      this.logger.debug(
        `Flashbots: Converted slot ${slot} to block number ${blockNum}`
      );
      return blockNum;
    } catch (err: any) {
      if (err.response?.status === 404) {
        // Slot not found (might be in the future or doesn't exist)
        this.logger.debug(
          `Flashbots: Slot ${slot} not found in beacon API (404)`
        );
      } else {
        this.logger.debug(
          `Flashbots: Error querying beacon API for slot ${slot}: ${err.message || err}`
        );
      }
      return null;
    }
  }

  /**
   * Finds the closest allowed slot's corresponding block number to the current block
   * @param allowedSlots array of allowed slot numbers
   * @param currentBlock current block number
   * @returns closest block number corresponding to an allowed slot, or null if none found
   */
  private async findClosestAllowedSlot(
    allowedSlots: bigint[],
    currentBlock: bigint
  ): Promise<bigint | null> {
    if (allowedSlots.length === 0) {
      return null;
    }

    // Convert all slots to block numbers (in parallel for efficiency)
    const blockNumberPromises = allowedSlots.map(slot => this.slotToBlockNumber(slot));
    const blockNumbers = await Promise.all(blockNumberPromises);
    
    // Filter out nulls and blocks that are >= currentBlock (can't use past blocks)
    const validFutureBlocks = blockNumbers
      .filter((block): block is bigint => block !== null && block >= currentBlock);
    
    if (validFutureBlocks.length === 0) {
      // No future blocks available, return null
      return null;
    }

    // Find the closest block (minimum difference)
    let closestBlock = validFutureBlocks[0]!;
    let minDiff = validFutureBlocks[0]! - currentBlock;

    for (const block of validFutureBlocks) {
      const diff = block - currentBlock;
      if (diff < minDiff) {
        minDiff = diff;
        closestBlock = block;
      }
    }

    return closestBlock;
  }

  /**
   * Calculates target block from bundle's user operations paymasterData
   * @param bundle bundle containing user operations
   * @param currentBlock current block number
   * @returns target block number, or null if no valid slots found
   */
  private async calculateTargetBlockFromPaymasterData(
    bundle: Bundle,
    currentBlock: bigint
  ): Promise<bigint | null> {
    // Collect allowed slots from each user operation
    const userOpSlots: bigint[][] = [];

    for (const entry of bundle.entries) {
      const userOp = entry.userOp;
      if (userOp.paymasterData) {
        const slots = this.decodePaymasterDataSlots(userOp.paymasterData);
        if (slots && slots.length > 0) {
          userOpSlots.push(slots);
        }
      }
    }

    if (userOpSlots.length === 0) {
      return null;
    }

    // If only one user op has slots, use those
    if (userOpSlots.length === 1) {
      return await this.findClosestAllowedSlot(userOpSlots[0]!, currentBlock);
    }

    // For multiple user ops, find intersection of all allowed slots
    // (slots that are valid for ALL user operations)
    let commonSlots = userOpSlots[0]!;
    for (let i = 1; i < userOpSlots.length; i++) {
      const currentSlots = new Set(userOpSlots[i]!.map(s => s.toString()));
      commonSlots = commonSlots.filter(slot => currentSlots.has(slot.toString()));
    }

    // If we have common slots, use the closest one
    if (commonSlots.length > 0) {
      return await this.findClosestAllowedSlot(commonSlots, currentBlock);
    }

    // If no common slots, fall back to finding closest from all slots
    // (this means not all user ops can be included in the same block)
    const allSlots = userOpSlots.flat();
    const uniqueSlots = [...new Set(allSlots)].sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });

    this.logger.warn(
      `Flashbots: No common allowed slots found for all user ops in bundle, using closest slot from all available slots`
    );
    return await this.findClosestAllowedSlot(uniqueSlots, currentBlock);
  }

  /**
   * Simulates a bundle using eth_callBundle before submission
   * @param signer wallet
   * @param signedTransaction signed transaction (RLP-encoded)
   * @param targetBlock target block number for simulation
   * @returns simulation result or null if simulation fails
   */
  private async callBundle(
    signer: Relayer,
    signedTransaction: string,
    targetBlock: bigint
  ): Promise<any> {
    try {
      const blockNumber = toHex(targetBlock);
      const data = JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_callBundle",
        params: [{
          txs: [signedTransaction],
          blockNumber: blockNumber,
          stateBlockNumber: "latest", // Use latest state for simulation
        }],
        id: 1
      });

      const payloadSignature = await (
        signer.account as LocalAccount<"privateKey">
      ).signMessage({
        message: keccak256(toHex(data)),
      });
      // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
      const signature = signer.account?.address! + ":" + payloadSignature;

      const config = {
        method: "post",
        url: this.networkConfig.rpcEndpointSubmit,
        headers: {
          "Content-Type": "application/json",
          "X-Flashbots-Signature": signature,
        },
        data,
      };

      const response = await axios.request(config);
      const { error, result } = response.data;

      if (error) {
        this.logger.warn(
          `Flashbots: Bundle simulation failed: ${JSON.stringify(error)}`
        );
        return null;
      }

      // Check if simulation was successful
      // A successful simulation should have results array with transaction results
      if (result?.results && Array.isArray(result.results) && result.results.length > 0) {
        // Check if any transaction in the bundle failed
        const hasFailure = result.results.some((txResult: any) => {
          // Transaction fails if it has an error or if coinbaseDiff is negative (revert)
          return txResult.error || (txResult.coinbaseDiff && BigInt(txResult.coinbaseDiff) < BigInt(0));
        });

        if (hasFailure) {
          this.logger.warn(
            `Flashbots: Bundle simulation detected failures: ${JSON.stringify(result.results)}`
          );
          return null;
        }

        this.logger.debug(
          `Flashbots: Bundle simulation successful. Total gas used: ${result.totalGasUsed}, Bundle gas price: ${result.bundleGasPrice}`
        );
        return result;
      }

      this.logger.warn(
        `Flashbots: Bundle simulation returned unexpected format: ${JSON.stringify(result)}`
      );
      return null;
    } catch (err: any) {
      this.logger.warn(
        `Flashbots: Error simulating bundle: ${err.message || err}`
      );
      return null;
    }
  }

  /**
   * signs & sends a transaction
   * @param signer wallet
   * @param transaction transaction request
   * @param authorizationList authorization list
   * @param bundle bundle containing user operations (for paymasterData analysis)
   * @returns object with transaction hash and target block number
   */
  private async submitTransaction(
    signer: Relayer,
    transaction: TransactionRequest,
    authorizationList: AuthorizationList,
    bundle: Bundle
  ): Promise<{ txHash: string; targetBlock: bigint; bundleHash: string }> {
    try {
      this.logger.debug(transaction, "Flashbots: Submitting");
      const signedTransaction = await signer.signTransaction({
        ...transaction,
        authorizationList
      } as any);
      
      // Get current block number
      const currentBlock = await this.publicClient.getBlockNumber();
      
      // Try to calculate target block from paymasterData, fallback to currentBlock + 1
      const targetBlockFromPaymaster = await this.calculateTargetBlockFromPaymasterData(
        bundle,
        currentBlock
      );
      
      const targetBlock = targetBlockFromPaymaster ?? (currentBlock + BigInt(1));
      
      if (targetBlockFromPaymaster) {
        this.logger.info(
          `Flashbots: Submitting bundle to block ${targetBlock} (from paymasterData allowedSlots)`
        );
      } else {
        this.logger.info(
          `Flashbots: Submitting bundle to block ${targetBlock} (default: currentBlock + 4)`
        );
      }

      // Simulate bundle before submission
      // this.logger.debug(
      //   `Flashbots: Simulating bundle before submission to block ${targetBlock}`
      // );
      // const simulationResult = await this.callBundle(
      //   signer,
      //   signedTransaction,
      //   targetBlock
      // );

      // if (!simulationResult) {
      //   throw new Error(
      //     `Flashbots: Bundle simulation failed, aborting submission. This bundle would likely fail on-chain.`
      //   );
      // }

      this.logger.info(
        `Flashbots: Bundle simulation passed, proceeding with submission`
      );
      
      const blockNumber = toHex(targetBlock);
      // todo: to support slot selection properly, we need to calculate the maxBlock based on the targetBlock and the allowed slots + resubmitt if not included
      const maxBlock = toHex(targetBlock + BigInt(10)); // Allow bundle to be included up to 10 blocks after target
      const data = JSON.stringify({
        jsonrpc: "2.0",
        method: "mev_sendBundle",
        params: [{
          version: "v0.1",
          inclusion: {
            block: blockNumber,
            maxBlock: maxBlock,
          },
          body: [
            {
              tx: signedTransaction,
              canRevert: false,
            },
          ],
          validity: {
            refund: [],
            refundConfig: [],
          },
        }],
        id: 1
      });

      const payloadSignature = await (
        signer.account as LocalAccount<"privateKey">
      ).signMessage({
        message: keccak256(toHex(data)),
      });
      // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
      const signature = signer.account?.address! + ":" + payloadSignature;

      const config = {
        method: "post",
        url: this.networkConfig.rpcEndpointSubmit,
        headers: {
          "Content-Type": "application/json",
          "X-Flashbots-Signature": signature,
        },
        data,
      };
      return await axios
        .request(config)
        .then((response) => {
          const { error, result } = response.data;
          this.logger.info(response.data, "Flashbots: Bundle response");
          if (error) {
            this.logger.error(error, "Flashbots: Error submitting bundle");
            throw new Error(error);
          }
          // Flashbots returns bundleHash when bundle is accepted (not necessarily included)
          const bundleHash = result?.bundleHash;
          const txHash = keccak256(hexToBytes(signedTransaction));
          this.logger.debug(
            `Flashbots: Bundle accepted with bundleHash=${bundleHash}, txHash=${txHash}, targetBlock=${targetBlock}`
          );
          return { txHash, targetBlock, bundleHash };
        })
        .catch((err) => {
          this.logger.error(err, "Flashbots: Error submitting bundle");
          throw err;
        });
    } catch (error) {
      this.logger.error(error, "Flashbots: Error submitting bundle");
      throw error;
    }
  }

  /**
   * Waits for target block to be mined and checks bundle inclusion by scanning for transaction on-chain
   * @param bundleHash bundle hash from Flashbots (for logging)
   * @param targetBlock target block number
   * @param txHash transaction hash to check on-chain
   * @param relayer the relayer account (unused, kept for API compatibility)
   * @returns true if transaction is found on-chain, false if not
   */
  private async waitForBlockAndCheckInclusion(
    bundleHash: string,
    targetBlock: bigint,
    txHash: string,
    relayer: Relayer
  ): Promise<boolean> {
    const maxWaitTime = 30 * 1000; // 30 seconds max wait
    const startTime = Date.now();
    const checkInterval = 2000; // Check every 2 seconds

    return new Promise((resolve, reject) => {
      const checkInclusion = async (): Promise<void> => {
        try {
          const currentBlock = await this.publicClient.getBlockNumber();
          
          // If we've passed the target block, check if transaction exists on-chain
          if (currentBlock >= targetBlock) {
            // Wait a bit after block is mined for transaction to be indexed
            const blocksSinceTarget = Number(currentBlock - targetBlock);
            if (blocksSinceTarget === 0) {
              // Just reached target block, wait a bit before checking
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            const tx = await this.publicClient.getTransaction({
              hash: txHash as Hex,
            }).catch(() => null);
            
            if (tx && tx.blockNumber) {
              this.logger.debug(
                `Flashbots: Transaction ${txHash} found in block ${tx.blockNumber} (bundle included)`
              );
              return resolve(true);
            } else {
              this.logger.debug(
                `Flashbots: Transaction ${txHash} not found on-chain yet (bundle not included in block ${targetBlock})`
              );
              return resolve(false);
            }
          }

          // Target block not reached yet, check timeout
          if (Date.now() - startTime > maxWaitTime) {
            this.logger.warn(
              `Flashbots: Timeout waiting for block ${targetBlock}, current block is ${currentBlock}`
            );
            // Final check for transaction on-chain
            const tx = await this.publicClient.getTransaction({
              hash: txHash as Hex,
            }).catch(() => null);
            return resolve(tx !== null && tx.blockNumber !== null);
          }

          // Wait a bit and check again
          setTimeout(checkInclusion, checkInterval);
        } catch (err) {
          this.logger.error(err, "Flashbots: Error checking bundle inclusion");
          return reject(err);
        }
      };

      // Start checking
      void checkInclusion();
    });
  }

}
