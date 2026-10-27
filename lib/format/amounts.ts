export function formatUsd(value: number | null): string {
  if (value == null) return "Not reported";
  if (!(value > 0)) return "$0";
  if (value >= 1000) return `$${grouped(Math.round(value))}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.0001) return `$${trimZeros(value.toFixed(6))}`;
  const digits = Math.min(12, Math.ceil(-Math.log10(value)) + 2);
  return `$${trimZeros(value.toFixed(digits))}`;
}

export function formatPct(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : 1;
  return `${Number(abs.toFixed(digits))}%`;
}

export function formatMultiple(value: number): string {
  return `${Number(value.toFixed(1))}×`;
}

function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function trimZeros(value: string): string {
  return value.replace(/0+$/, "").replace(/\.$/, "");
}
