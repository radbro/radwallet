/** Request and override shapes for the approval window. */
import type { DappTxRequest } from '@radwallet/core';

export interface ApprovalRequest {
  id: string;
  origin: string;
  method: 'eth_requestAccounts' | 'personal_sign' | 'eth_sendTransaction'
    | 'eth_signTypedData_v4' | 'eth_signTypedData_v3' | 'wallet_switchEthereumChain';
  params: unknown[];
  chainId: number;
  endpoint: string;
}

export interface ApprovalOverride {
  tx?: DappTxRequest;
  address?: string;
}
