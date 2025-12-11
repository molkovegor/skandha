import { IDbController, Logger } from "@skandha/types/lib";
import { PublicClient } from "viem";
import { ReputationService } from "../ReputationService";
import { MempoolService } from "../MempoolService";
import { EntryPointService } from "../EntryPointService";
import { TransactionBundleService } from "../TransactionBundleService/service";
import { NetworkConfig } from "../../interfaces";
import { ExecutorEventBus } from "../SubscriptionService";
import {
  EntryPointV7EventsService,
  IEntryPointEventsService,
} from "./versions";
import { TransactionBundlePollingEventService } from "./TransactionBundleService/service";

export class EventsService {
  private eventsService: {
    [address: string]: IEntryPointEventsService;
  } = {};
  private transactionBundlePollingEventService?: TransactionBundlePollingEventService;

  constructor(
    private chainId: number,
    private networkConfig: NetworkConfig,
    private reputationService: ReputationService,
    private mempoolService: MempoolService,
    private entryPointService: EntryPointService,
    private transactionBundleService: TransactionBundleService,
    private publicClient: PublicClient,
    private eventBus: ExecutorEventBus,
    private db: IDbController,
    private logger: Logger
  ) {
    for (const addr of this.networkConfig.entryPoints) {
      const address = addr.toLowerCase();
      this.eventsService[address] = new EntryPointV7EventsService(
        addr,
        this.chainId,
        this.entryPointService.getEntryPoint(address).contract,
        this.publicClient,
        this.reputationService,
        this.mempoolService,
        this.eventBus,
        this.db,
        this.logger,
        this.networkConfig.pollingInterval,
        this.networkConfig.disableWatchContract
      );
      this.eventsService[address].initEventListener();
    }

    // Initialize transaction bundle polling service
    this.transactionBundlePollingEventService = new TransactionBundlePollingEventService(
      this.transactionBundleService,
      this.publicClient,
      this.logger,
      this.networkConfig.pollingInterval
    );
    this.transactionBundlePollingEventService.initEventListener();
  }
}
