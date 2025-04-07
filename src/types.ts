export interface User {
  uuid: string;
  user_name: string;
  liquid_addresses: string[];
  used_addresses: string[];
}

export interface Swap {
  swap_id: string;
  wallet_id: string;
  amount: string;
  note?: string;
  preImage: string;
  preImageHash: string;
  privateKey: string;
  pubKey: string;
  claimAddress: string;
  invoice: string;
  swapTree: string;
  lockupAddress: string;
  refundPubKey: string;
  refundAddress: string;
  timeoutBlockHeight: number;
  onChainAmount: string;
  blindingKey: string;
}

export interface LNURLPayResponse {
  callback: string;
  maxSendable: number;
  minSendable: number;
  metadata: string;
  commentAllowed: number;
  tag: string;
}

export interface BoltzResponse {
  id: string;
  invoice: string;
  swapTree: any;
  lockupAddress: string;
  refundPublicKey: string;
  refundAddress: string;
  timeoutBlockHeight: number;
  onchainAmount: string;
  blindingKey: string;
}

export interface PaymentResponse {
  pr: string;
  route: any[];
} 