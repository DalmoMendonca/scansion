import { readFileSync } from 'node:fs';

function loadMegaReservePromotionRules() {
  try {
    const raw = readFileSync(
      new URL('../../artifacts/mega-reserve-rule-candidates-selected.json', import.meta.url),
      'utf8'
    );
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((entry) => entry?.rule).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export const STRICT_MEGA_RESERVE_PROMOTION_RULES = loadMegaReservePromotionRules();
