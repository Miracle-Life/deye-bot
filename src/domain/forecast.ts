const MIN_CHARGE_W = 100;

export function runtimeHours(soc: number, loadW: number, capacityKwh: number, reservePct: number): number | null {
  if (loadW <= 0) return null;
  if (soc <= reservePct) return 0;
  return (((soc - reservePct) / 100) * capacityKwh * 1000) / loadW;
}

export function timeToFullMin(soc: number, chargeW: number, capacityKwh: number): number | null {
  if (soc >= 100) return 0;
  if (chargeW < MIN_CHARGE_W) return null;
  return ((((100 - soc) / 100) * capacityKwh * 1000) / chargeW) * 60;
}
