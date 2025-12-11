import { Mutex } from "async-mutex";
import { IDbController, Logger } from "@skandha/types/lib";
import { TransactionBundleStatus } from "@skandha/types/lib/executor";
import { TransactionBundleEntry } from "../../entities/TransactionBundleEntry";
import { now } from "../../utils";

export class TransactionBundleService {
  private BUNDLE_COLLECTION_KEY: string;
  private BUNDLE_HASHES_COLLECTION_PREFIX: string;
  private mutex = new Mutex();

  constructor(
    private db: IDbController,
    private chainId: number,
    private logger: Logger
  ) {
    this.BUNDLE_COLLECTION_KEY = `${chainId}:TXBUNDLEKEYS`;
    this.BUNDLE_HASHES_COLLECTION_PREFIX = "TXBUNDLEHASH:";
  }

  /**
   * Get bundle by tx1Hash
   */
  async getBundleByTx1Hash(tx1Hash: string): Promise<TransactionBundleEntry | null> {
    const key = this.getKeyFromTx1Hash(tx1Hash);
    return this.findByKey(key);
  }

  /**
   * Get bundles by status
   */
  async getBundlesByStatus(status?: TransactionBundleStatus): Promise<TransactionBundleEntry[]> {
    const allBundles = await this.fetchAll();
    if (status !== undefined) {
      return allBundles.filter((bundle) => bundle.status === status);
    }
    return allBundles;
  }

  /**
   * Get new bundles sorted (similar to getNewEntriesSorted for mempool)
   */
  async getNewBundlesSorted(size: number, offset = 0): Promise<TransactionBundleEntry[]> {
    const allBundles = await this.fetchAll();
    return allBundles
      .filter((bundle) => bundle.status === TransactionBundleStatus.New)
      .sort((a, b) => a.submittedTime - b.submittedTime) // Sort by submission time
      .slice(offset, offset + size);
  }

  /**
   * Attempt to bundle (increment submitAttempts)
   */
  async attemptToBundle(entries: TransactionBundleEntry[]): Promise<void> {
    for (const entry of entries) {
      entry.submitAttempts++;
      entry.lastUpdatedTime = now();
      await this.update(entry);
    }
  }

  /**
   * Add a new bundle entry
   */
  async addBundle(entry: TransactionBundleEntry): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const existingEntry = await this.find(entry);
      if (existingEntry) {
        this.logger.debug("TransactionBundle: Bundle already exists, updating");
        await this.update(entry);
        return;
      }

      const bundleKeys = await this.fetchKeys();
      const key = this.getKey(entry);
      bundleKeys.push(key);
      await this.db.put(this.BUNDLE_COLLECTION_KEY, bundleKeys);
      await this.db.put(key, { ...entry, lastUpdatedTime: now() });
      await this.saveBundleHash(entry.bundleHash, entry);
      this.logger.debug("TransactionBundle: Bundle added");
    });
  }

  /**
   * Update bundle status
   */
  async updateStatus(
    tx1Hash: string,
    status: TransactionBundleStatus,
    params?: {
      bundleHash?: string;
      revertReason?: string;
    }
  ): Promise<void> {
    const entry = await this.getBundleByTx1Hash(tx1Hash);
    if (!entry) {
      this.logger.warn(`TransactionBundle: Bundle not found: tx1Hash=${tx1Hash}`);
      return;
    }
    entry.setStatus(status, params);
    await this.update(entry);
  }

  /**
   * Update bundle entry
   */
  async update(entry: TransactionBundleEntry): Promise<void> {
    entry.lastUpdatedTime = now();
    const key = this.getKey(entry);
    await this.db.put(key, entry);
  }

  /**
   * Private helper methods
   */
  private async find(entry: TransactionBundleEntry): Promise<TransactionBundleEntry | null> {
    return this.findByKey(this.getKey(entry));
  }

  private async findByKey(key: string): Promise<TransactionBundleEntry | null> {
    const rawEntry = await this.db.get<TransactionBundleEntry>(key).catch(() => null);
    if (!rawEntry) return null;
    return new TransactionBundleEntry(rawEntry);
  }

  private async fetchAll(): Promise<TransactionBundleEntry[]> {
    const keys = await this.fetchKeys();
    if (keys.length === 0) return [];
    const rawEntries = await this.db.getMany<TransactionBundleEntry>(keys).catch(() => []);
    return rawEntries.map((raw) => new TransactionBundleEntry(raw));
  }

  private async fetchKeys(): Promise<string[]> {
    return this.db.get<string[]>(this.BUNDLE_COLLECTION_KEY).catch(() => []);
  }

  private getKey(entry: TransactionBundleEntry): string {
    return this.getKeyFromTx1Hash(entry.tx1Hash);
  }

  private getKeyFromTx1Hash(tx1Hash: string): string {
    return `${this.chainId}:TXBUNDLE:${tx1Hash}`;
  }

  private async saveBundleHash(bundleHash: string, entry: TransactionBundleEntry): Promise<void> {
    const key = this.getKey(entry);
    await this.db.put(`${this.BUNDLE_HASHES_COLLECTION_PREFIX}${bundleHash}`, key);
  }
}

