/**
 * Scan-level attributes for a Phase 3 row (pure).
 * - `regime.<key>`: the 1c market regime fields (pre-registered candidates for stock
 *   datasets). Crypto rows don't get them: the regime is stock-only (P3-0e).
 * - `macro.<key>`: P3-0f macro context, stored under Scan.regimeFeatures.macro. Exposed
 *   as conditioning columns only; candidateKeys never tests them until a later
 *   pre-registration update adds them.
 */
export function scanAttrs(regimeFeatures: Record<string, unknown> | null | undefined, opts: { regime: boolean }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(regimeFeatures ?? {})) {
    if (k === "macro") {
      if (v && typeof v === "object" && !Array.isArray(v)) for (const [mk, mv] of Object.entries(v)) out[`macro.${mk}`] = mv;
      continue;
    }
    if (opts.regime) out[`regime.${k}`] = v;
  }
  return out;
}
