import { readFileSync } from 'node:fs';

function loadUltraReservePromotionRules() {
  try {
    const raw = readFileSync(
      new URL('../../artifacts/ultra-reserve-rule-candidates-selected.json', import.meta.url),
      'utf8'
    );
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((entry) => entry?.rule).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export const STRICT_ULTRA_RESERVE_PROMOTION_RULES = loadUltraReservePromotionRules();
