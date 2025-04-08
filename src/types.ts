export interface User {
  uuid: string;
  user_name: string;
  liquid_addresses: string[];
  used_addresses: string[];
}

export interface Swap {
  swap_id: string;
  status: string;
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
  timeoutBlockHeight: number;
  onChainAmount: string;
  blindingKey: string;
  created_at?: Date;
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
  description: string;
  addressSignature: string;
}

export interface LockupTransactionResponse {
  hex: string;
  txid: string;
}

export interface BoltzClaimResponse {
  pubNonce: string;
  partialSignature: string;
}