import { formatUnits, parseUnits } from 'viem';

/** Parse exactly what was entered; token quantities must never be rounded. */
export function parseTokenAmount(human: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('Token decimals are unavailable.');
  }
  const quantity = human.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(quantity)) {
    throw new Error('Enter a token amount of zero or more.');
  }
  if ((quantity.split('.')[1]?.length ?? 0) > decimals) {
    throw new Error(`This token supports up to ${decimals} decimal places.`);
  }
  const amount = parseUnits(quantity, decimals);
  if (amount > (1n << 256n) - 1n) throw new Error('This amount is too large.');
  return amount;
}

/** Exact grouped display for values a user is about to authorize. */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  const [integer, fraction] = formatUnits(raw, decimals).split('.');
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction}` : '');
}
