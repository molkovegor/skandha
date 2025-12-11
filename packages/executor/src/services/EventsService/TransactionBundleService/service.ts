import { Logger } from "@skandha/types/lib";
import { PublicClient, Hex } from "viem";
import { TransactionBundleService } from "../../TransactionBundleService/service";
import { TransactionBundleStatus } from "@skandha/types/lib/executor";

export class TransactionBundlePollingEventService {
  private transactionBundlePollingInterval?: NodeJS.Timeout;

  constructor(
    private transactionBundleService: TransactionBundleService,
    private publicClient: PublicClient,
    private logger: Logger,
    private pollingInterval: number
  ) {}

  /**
   * Initialize transaction bundle monitoring
   * Monitor transaction bundles in Submitted status
   * Check if their tx1Hash transactions are on-chain and update status accordingly
   */
  initEventListener(): void {
    this.transactionBundlePollingInterval = setInterval(() => {
      void this.pollTransactionBundles();
    }, this.pollingInterval);
  }

  private async pollTransactionBundles(): Promise<void> {
    try {
      // Get all bundles in Submitted status
      const submittedBundles = await this.transactionBundleService.getBundlesByStatus(
        TransactionBundleStatus.Submitted
      );

      if (submittedBundles.length === 0) {
        return;
      }

      this.logger.debug(
        `Checking ${submittedBundles.length} submitted transaction bundles for on-chain status`
      );

      // Check each bundle's tx1Hash transaction
      for (const bundle of submittedBundles) {
        await this.checkBundleTransaction(bundle.tx1Hash);
      }
    } catch (error) {
      this.logger.error(
        error,
        "Error polling transaction bundles for on-chain status"
      );
    }
  }

  private async checkBundleTransaction(tx1Hash: string): Promise<void> {
    try {
      const bundle = await this.transactionBundleService.getBundleByTx1Hash(tx1Hash);
      if (!bundle) {
        return;
      }

      // Only process bundles in Submitted status (avoid race conditions)
      if (bundle.status !== TransactionBundleStatus.Submitted) {
        return;
      }

      // Check if maxBlock has passed and transaction is not on-chain
      if (bundle.maxBlock) {
        const currentBlock = await this.publicClient.getBlockNumber();
        if (currentBlock > bundle.maxBlock) {
          // Max block passed, transaction not included, mark as Cancelled
          await this.transactionBundleService.updateStatus(
            tx1Hash,
            TransactionBundleStatus.Cancelled,
            { revertReason: `Bundle not included before maxBlock ${bundle.maxBlock}, current block ${currentBlock}` }
          );
          this.logger.debug(
            `Transaction bundle ${tx1Hash} cancelled: maxBlock ${bundle.maxBlock} passed, current block ${currentBlock}`
          );
          return;
        }
      }

      // Check if transaction exists on-chain
      const tx = await this.publicClient.getTransaction({
        hash: tx1Hash as Hex,
      }).catch(() => null);

      if (!tx) {
        // Transaction not found yet, skip
        return;
      }

      // Transaction found, check if it has a block number (included)
      if (tx.blockNumber) {
        // Get transaction receipt to check if it succeeded or reverted
        const receipt = await this.publicClient.getTransactionReceipt({
          hash: tx1Hash as Hex,
        }).catch(() => null);

        if (receipt) {
          // Re-fetch bundle to ensure we have latest status
          const latestBundle = await this.transactionBundleService.getBundleByTx1Hash(tx1Hash);
          if (!latestBundle || latestBundle.status !== TransactionBundleStatus.Submitted) {
            return;
          }

          if (receipt.status === "success") {
            // Transaction succeeded, update to OnChain
            await this.transactionBundleService.updateStatus(
              tx1Hash,
              TransactionBundleStatus.OnChain
            );
            this.logger.debug(
              `Transaction bundle ${tx1Hash} confirmed on-chain at block ${receipt.blockNumber}`
            );
          } else if (receipt.status === "reverted") {
            // Transaction reverted, update to Reverted
            await this.transactionBundleService.updateStatus(
              tx1Hash,
              TransactionBundleStatus.Reverted,
              { revertReason: "Transaction reverted on-chain" }
            );
            this.logger.debug(
              `Transaction bundle ${tx1Hash} reverted on-chain at block ${receipt.blockNumber}`
            );
          }
        }
      }
    } catch (error) {
      this.logger.error(
        error,
        `Error checking transaction bundle ${tx1Hash}`
      );
    }
  }
}

