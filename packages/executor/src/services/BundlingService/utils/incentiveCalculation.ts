import { Logger } from "@skandha/types/lib";

export interface IncentiveCalculationParams {
  tx1GasLimit: bigint;
  tx2GasLimit: bigint;
  maxFeePerGas: bigint;
  networkConfig: {
    incentiveBaseAmount?: bigint;
    incentiveGasMultiplier?: bigint;
    incentiveMinAmount?: bigint;
    incentiveMaxAmount?: bigint;
  };
}

/**
 * Calculate incentive amount for builder based on gas costs and network conditions
 */
export async function calculateIncentiveAmount(
  params: IncentiveCalculationParams,
  logger: Logger
): Promise<bigint> {
  const {
    tx1GasLimit,
    tx2GasLimit,
    maxFeePerGas,
    networkConfig,
  } = params;

  // Base calculation: total gas cost * multiplier
  const totalGasLimit = tx1GasLimit + tx2GasLimit;
  const baseGasCost = totalGasLimit * maxFeePerGas;

  // Default multiplier: 1.1 (10% profit margin for builder)
  const multiplier = networkConfig.incentiveGasMultiplier ?? BigInt(110) / BigInt(100);
  let incentiveAmount = (baseGasCost * multiplier) / BigInt(100);

  // Apply base amount if configured
  if (networkConfig.incentiveBaseAmount) {
    incentiveAmount = incentiveAmount + networkConfig.incentiveBaseAmount;
  }

  // Apply min/max bounds
  if (networkConfig.incentiveMinAmount && incentiveAmount < networkConfig.incentiveMinAmount) {
    incentiveAmount = networkConfig.incentiveMinAmount;
  }
  if (networkConfig.incentiveMaxAmount && incentiveAmount > networkConfig.incentiveMaxAmount) {
    incentiveAmount = networkConfig.incentiveMaxAmount;
  }

  logger.debug(
    `Calculated incentive amount: ${incentiveAmount.toString()} wei (gas cost: ${baseGasCost.toString()}, multiplier: ${multiplier})`
  );

  return incentiveAmount;
}

