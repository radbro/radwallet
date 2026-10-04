/**
 * Transaction construction for assets the wallet already knows it owns.
 *
 * This module is deliberately pure: the UI can validate and preview the exact
 * calldata before the keyring is ever asked to sign it. The same transaction
 * shape crosses the extension message boundary without bigint values.
 */
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  toHex,
} from 'viem';
import type { DappTxRequest } from './chain.js';
import { parseTokenAmount } from './amounts.js';

const erc721TransferAbi = [{
  type: 'function',
  name: 'safeTransferFrom',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
  ],
  outputs: [],
}] as const;

const erc1155TransferAbi = [{
  type: 'function',
  name: 'safeTransferFrom',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'id', type: 'uint256' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ],
  outputs: [],
}] as const;

export type TransferAsset =
  | { kind: 'native'; symbol: string; decimals: number; amount: string }
  | { kind: 'erc20'; contract: `0x${string}`; symbol: string; decimals: number; amount: string }
  | { kind: 'erc721'; contract: `0x${string}`; symbol: string; tokenId: string }
  | { kind: 'erc1155'; contract: `0x${string}`; symbol: string; tokenId: string; amount: string };

function address(value: string, label: string): `0x${string}` {
  if (!isAddress(value)) throw new Error(`${label} is not a valid address`);
  return getAddress(value);
}

function positiveUnits(amount: string, decimals: number): bigint {
  const value = parseTokenAmount(amount, decimals);
  if (value <= 0n) throw new Error('amount must be greater than zero');
  return value;
}

function tokenId(value: string): bigint {
  if (!/^\d+$/.test(value.trim())) throw new Error('NFT token id must be a whole number');
  return BigInt(value);
}

/** Build the exact transaction the signer will receive. */
export function buildTransferTx(
  fromInput: string,
  toInput: string,
  asset: TransferAsset,
): DappTxRequest {
  const from = address(fromInput, 'sender');
  const to = address(toInput, 'recipient');

  if (asset.kind === 'native') {
    return { to, value: toHex(positiveUnits(asset.amount, asset.decimals)) as `0x${string}` };
  }

  const contract = address(asset.contract, 'token contract');
  if (asset.kind === 'erc20') {
    const amount = positiveUnits(asset.amount, asset.decimals);
    return {
      to: contract,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to, amount],
      }),
    };
  }

  if (asset.kind === 'erc721') {
    return {
      to: contract,
      data: encodeFunctionData({
        abi: erc721TransferAbi,
        functionName: 'safeTransferFrom',
        args: [from, to, tokenId(asset.tokenId)],
      }),
    };
  }

  return {
    to: contract,
    data: encodeFunctionData({
      abi: erc1155TransferAbi,
      functionName: 'safeTransferFrom',
      args: [from, to, tokenId(asset.tokenId), positiveUnits(asset.amount, 0), '0x'],
    }),
  };
}

export function transferLabel(asset: TransferAsset): { asset: string; amount: string } {
  if (asset.kind === 'erc721') return { asset: `${asset.symbol} #${asset.tokenId}`, amount: '1 NFT' };
  if (asset.kind === 'erc1155') {
    return { asset: `${asset.symbol} #${asset.tokenId}`, amount: asset.amount };
  }
  return { asset: asset.symbol, amount: asset.amount };
}
