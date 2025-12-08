import { IsEthereumAddress, IsString } from "class-validator";
import { Hex } from "viem";

export class SendBundledTransactionArgs {
  @IsString()
  transaction!: Hex;

  @IsEthereumAddress()
  builderAddress!: Hex;
}

