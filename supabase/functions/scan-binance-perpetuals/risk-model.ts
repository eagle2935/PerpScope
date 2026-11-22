export type RiskSetup = {
  entry: number;
  stop: number;
  target: number;
  rr: 3;
  stopPct: number;
  riskDistance: number;
};

export function riskSetup(side: "LONG" | "SHORT", price: number, atr15: number | null): RiskSetup | null {
  if (!Number.isFinite(price) || price <= 0 || atr15 === null || !Number.isFinite(atr15) || atr15 <= 0) return null;
  const distance = atr15 * 1.5;
  const pct = distance / price * 100;
  if (pct < 0.25 || pct > 3.0) return null;
  const stop = side === "LONG" ? price - distance : price + distance;
  const target = side === "LONG" ? price + distance * 3 : price - distance * 3;
  if (!(stop > 0 && (side === "LONG" ? stop < price && target > price : stop > price && target < price))) return null;
  const rr = Math.abs(target - price) / Math.abs(price - stop);
  if (!Number.isFinite(rr) || rr < 2.99 || rr > 3.01) return null;
  return { entry: price, stop, target, rr: 3, stopPct: pct, riskDistance: distance };
}
