import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function flattenMessages(value: unknown, prefix = '', output: Record<string, string> = {}): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') output[path] = child;
    else flattenMessages(child, path, output);
  }
  return output;
}

async function viewSources(folder: 'sections' | 'snippets'): Promise<string[]> {
  const directory = fileURLToPath(new URL(`../views/${folder}/`, import.meta.url).href);
  const names = (await readdir(directory)).filter((name) => name.endsWith('.liquid'));
  return Promise.all(names.map((name) => readFile(fileURLToPath(new URL(`../views/${folder}/${name}`, import.meta.url).href), 'utf8')));
}

describe('events UI locale catalog', () => {
  it('defines every translation key used by plugin admin views', async () => {
    const catalog = flattenMessages(JSON.parse(await readFile(fileURLToPath(new URL('../views/locales/en.json', import.meta.url).href), 'utf8')));
    const sources = (await Promise.all([viewSources('sections'), viewSources('snippets')])).flat();
    const usedKeys = sources.flatMap((source) => [
      ...source.matchAll(/["']([a-z0-9_.:-]+)["']\s*\|\s*t\b/gi),
    ].map((match) => match[1]));

    expect(usedKeys.length).toBeGreaterThan(0);
    expect([...new Set(usedKeys.filter((key) => !(key in catalog)))]).toEqual([]);
    expect(Object.values(catalog).some((value) => /[\u0000-\u001f]/.test(value))).toBe(false);
  });

  it('ships valid overrides for every CMS interface locale', async () => {
    const english = flattenMessages(JSON.parse(await readFile(fileURLToPath(new URL('../views/locales/en.json', import.meta.url).href), 'utf8')));
    for (const locale of ['zh-hans', 'zh-hant']) {
      const localized = flattenMessages(JSON.parse(await readFile(fileURLToPath(new URL(`../views/locales/${locale}.json`, import.meta.url).href), 'utf8')));
      expect(Object.keys(localized).length).toBeGreaterThan(0);
      expect(Object.keys(localized).filter((key) => !(key in english))).toEqual([]);
      if (locale === 'zh-hant') expect(Object.keys(english).filter((key) => !(key in localized))).toEqual([]);
      expect(Object.values(localized).some((value) => /[\u0000-\u001f]/.test(value))).toBe(false);
    }
  });
});
