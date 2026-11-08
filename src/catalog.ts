import fs from 'node:fs';
import path from 'node:path';

export type FlatCatalog = Map<string, string>;

export type LoadedCatalogs = {
  locales: Array<string>;
  byLocale: Map<string, FlatCatalog>;
  /** Source-locale keys whose value is not a string (arrays, numbers, …), read via `t.raw`. */
  nonString: Map<string, unknown>;
  /** Keys defined with different values in two catalog files of the same locale. */
  collisions: Array<{locale: string; key: string; files: [string, string]}>;
  filesByLocale: Map<string, Array<string>>;
};

function segmentToRegExp(segment: string): RegExp {
  const source = segment
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{locale\\\}/g, '(?<locale>[A-Za-z0-9_-]+)')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${source}$`);
}

/**
 * Expands a catalog path pattern such as `messages/{locale}.json` or
 * `locales/{locale}/*.json` into the files that exist on disk, grouped by locale.
 */
export function resolveCatalogFiles(
  pattern: string,
  projectRoot: string
): Map<string, Array<string>> {
  const segments = pattern.split('/').filter(Boolean);
  const result = new Map<string, Array<string>>();

  function walk(dir: string, index: number, locale: string | undefined) {
    const segment = segments[index];
    const isLast = index === segments.length - 1;
    const isStatic = !/[{*]/.test(segment);
    if (isStatic) {
      const next = path.join(dir, segment);
      if (!fs.existsSync(next)) return;
      if (isLast) addFile(next, locale);
      else walk(next, index + 1, locale);
      return;
    }
    const regExp = segmentToRegExp(segment);
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const match = regExp.exec(entry.name);
      if (!match) continue;
      const nextLocale = match.groups?.locale ?? locale;
      const next = path.join(dir, entry.name);
      if (isLast) {
        if (entry.isFile()) addFile(next, nextLocale);
      } else if (entry.isDirectory()) {
        walk(next, index + 1, nextLocale);
      }
    }
  }

  function addFile(file: string, locale: string | undefined) {
    if (!locale) throw new Error(`Pattern "${pattern}" must contain {locale}.`);
    const list = result.get(locale) ?? [];
    list.push(file);
    result.set(locale, list);
  }

  walk(projectRoot, 0, undefined);
  for (const list of result.values()) list.sort();
  return result;
}

function flatten(
  value: unknown,
  prefix: string,
  strings: Map<string, string>,
  others: Map<string, unknown>
) {
  if (typeof value === 'string') {
    strings.set(prefix, value);
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, strings, others);
    }
  } else {
    others.set(prefix, value);
  }
}

export function loadCatalogs(
  pattern: string,
  projectRoot: string,
  sourceLocale: string
): LoadedCatalogs {
  const filesByLocale = resolveCatalogFiles(pattern, projectRoot);
  if (!filesByLocale.has(sourceLocale)) {
    throw new Error(
      `No catalog found for source locale "${sourceLocale}" with pattern "${pattern}".`
    );
  }

  const byLocale = new Map<string, FlatCatalog>();
  const nonString = new Map<string, unknown>();
  const collisions: LoadedCatalogs['collisions'] = [];

  for (const [locale, files] of filesByLocale) {
    const merged: FlatCatalog = new Map();
    const fileByKey = new Map<string, string>();
    for (const file of files) {
      const strings = new Map<string, string>();
      const others = new Map<string, unknown>();
      flatten(JSON.parse(fs.readFileSync(file, 'utf8')), '', strings, others);
      for (const [key, value] of strings) {
        const previous = merged.get(key);
        if (previous !== undefined && previous !== value) {
          collisions.push({locale, key, files: [fileByKey.get(key)!, file]});
        }
        merged.set(key, value);
        fileByKey.set(key, file);
      }
      if (locale === sourceLocale) {
        for (const [key, value] of others) nonString.set(key, value);
      }
    }
    byLocale.set(locale, merged);
  }

  const locales = [
    sourceLocale,
    ...[...filesByLocale.keys()].filter((locale) => locale !== sourceLocale).sort()
  ];
  return {locales, byLocale, nonString, collisions, filesByLocale};
}
