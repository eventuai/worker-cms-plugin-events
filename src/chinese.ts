// Simplified/Traditional Chinese conversion, used to widen advanced-search
// queries: a search for 苏玮 should also match 蘇瑋 and vice versa. The maps are
// character-level 1:1 conversions generated from the OpenCC dictionaries (see
// scripts/gen-chinese-chars.mjs); that is enough for substring LIKE matching.

import { S2T_KEYS, S2T_VALS, T2S_KEYS, T2S_VALS } from './chinese-chars';

function buildMap(keys: string, vals: string): Map<string, string> {
  const map = new Map<string, string>();
  const k = [...keys];
  const v = [...vals];
  for (let i = 0; i < k.length; i++) map.set(k[i], v[i]);
  return map;
}

const S2T = buildMap(S2T_KEYS, S2T_VALS);
const T2S = buildMap(T2S_KEYS, T2S_VALS);

/** Convert each character through `map`, leaving unmapped characters as-is. */
function convert(value: string, map: Map<string, string>): string {
  let out = '';
  for (const char of value) out += map.get(char) ?? char;
  return out;
}

export function toTraditional(value: string): string {
  return convert(value, S2T);
}

export function toSimplified(value: string): string {
  return convert(value, T2S);
}

/**
 * Returns the distinct set of term variants to search for. For non-Chinese
 * input this is just `[term]`, so callers behave exactly as before. For Chinese
 * input it adds the fully-simplified and fully-traditional forms so a query in
 * either script matches content stored in the other.
 */
export function chineseSearchVariants(term: string): string[] {
  if (!term) return [term];
  const simplified = toSimplified(term);
  const traditional = toTraditional(term);
  const variants = new Set<string>([term, simplified, traditional]);
  return [...variants];
}
