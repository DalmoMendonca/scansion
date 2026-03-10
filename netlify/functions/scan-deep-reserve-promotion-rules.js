import { readFileSync } from 'node:fs';

function loadDeepReservePromotionRules() {
  try {
    const raw = readFileSync(
      new URL('../../artifacts/deep-reserve-rule-candidates-selected.json', import.meta.url),
      'utf8'
    );
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((entry) => entry?.rule).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export const STRICT_DEEP_RESERVE_PROMOTION_RULES = loadDeepReservePromotionRules();
