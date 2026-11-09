import fs from 'node:fs';
import path from 'node:path';
import createJsonCodec from '@eloqnt/format-json';
import createPoCodec from '@eloqnt/format-po';
import type {Edit, PlannedMessage} from './plan.js';

export type CatalogFormat = 'po' | 'json';

type CodecMessage = {
  id: string;
  message: string;
  description: Array<string>;
  references: Array<{path: string; line?: number; column?: number}>;
  [key: string]: unknown;
};

/**
 * `textByFile` holds the text the offsets were computed on (TypeScript strips a BOM when reading),
 * so edits never land one character off; a BOM on disk is put back.
 */
export function applyEdits(edits: Array<Edit>, textByFile: Map<string, string>) {
  const byFile = new Map<string, Array<Edit>>();
  for (const edit of edits) {
    const list = byFile.get(edit.file) ?? [];
    list.push(edit);
    byFile.set(edit.file, list);
  }
  for (const [file, list] of byFile) {
    const onDisk = fs.readFileSync(file, 'utf8');
    let text = textByFile.get(file) ?? onDisk;
    // Apply from the end so earlier offsets stay valid.
    for (const edit of list.sort((a, b) => b.start - a.start || b.end - a.end)) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
    const bom = onDisk.startsWith('﻿') && !text.startsWith('﻿') ? '﻿' : '';
    fs.writeFileSync(file, bom + text);
  }
}

/**
 * next-intl 4.14.0 moved PO catalogs to the source text in `msgid` and the key in `msgctxt`. An older
 * extractor reads that layout as namespace + key and rewrites the catalogs with every translation empty.
 */
export function assertNextIntlSupportsPo(options: {projectRoot: string; format: CatalogFormat}) {
  if (options.format !== 'po') return;
  for (let dir = options.projectRoot; ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'node_modules/next-intl/package.json');
    if (fs.existsSync(file)) {
      const {version} = JSON.parse(fs.readFileSync(file, 'utf8')) as {version: string};
      const [major, minor] = version.split('.').map(Number);
      if (major < 4 || (major === 4 && minor < 14)) {
        throw new Error(
          `next-intl ${version} is installed, but PO catalogs written by this codemod need next-intl 4.14.0 or newer: ` +
            'older extractors erase their translations on the next `next dev` or `next build`. ' +
            'Upgrade next-intl (including workspace packages), or use --format json with a separate --out. Nothing was changed.'
        );
      }
      return;
    }
    if (dir === path.dirname(dir)) return;
  }
}

/** Merging into the previous layout would write a catalog next-intl refuses to read. */
export function assertCatalogsSupported(options: {
  outDir: string;
  format: CatalogFormat;
  locales: Array<string>;
  sourceFiles: Array<string>;
}) {
  if (options.format === 'json') {
    // The extractor deletes every key it can't find in the code, including keys of skipped calls.
    for (const locale of options.locales) {
      const file = path.join(options.outDir, `${locale}.json`);
      if (options.sourceFiles.includes(file)) {
        throw new Error(
          `${file} is one of the old catalogs. Writing extraction catalogs there would let the extractor delete ` +
            'the translations of calls that could not be converted. Pass a different --out. Nothing was changed.'
        );
      }
    }
    return;
  }
  for (const locale of options.locales) {
    const file = path.join(options.outDir, `${locale}.po`);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('X-Crowdin-SourceKey: msgstr')) {
      throw new Error(
        `${file} uses the previous PO layout of next-intl, which current versions refuse to read. ` +
          'Migrate it (https://github.com/amannn/next-intl/pull/2393), or delete it if it has no entries, ' +
          'then run the codemod again. Nothing was changed.'
      );
    }
  }
}

export function writeCatalogs(
  messages: Array<PlannedMessage>,
  options: {outDir: string; format: CatalogFormat; sourceLocale: string; locales: Array<string>}
) {
  if (messages.length === 0) return;
  const codec = options.format === 'po' ? createPoCodec() : createJsonCodec();
  const extension = `.${options.format}`;
  fs.mkdirSync(options.outDir, {recursive: true});

  // Like the extractor, every locale is encoded against the source catalog: it provides the
  // source text (`msgid`) and decides which entries exist. Target entries without a source are orphans.
  const sourceMessagesById = new Map<string, CodecMessage>();
  const localeList = [options.sourceLocale, ...options.locales.filter((locale) => locale !== options.sourceLocale)];

  for (const locale of localeList) {
    const file = path.join(options.outDir, `${locale}${extension}`);
    const isSource = locale === options.sourceLocale;
    const existing = new Map<string, CodecMessage>();
    if (fs.existsSync(file)) {
      for (const message of codec.decode(fs.readFileSync(file, 'utf8'), {locale, sourceLocale: options.sourceLocale})) {
        existing.set(message.id, message);
      }
    }

    const merged = new Map<string, CodecMessage>();
    if (isSource) {
      for (const [id, message] of existing) merged.set(id, message);
    } else {
      for (const [id, message] of existing) if (sourceMessagesById.has(id)) merged.set(id, message);
    }
    for (const message of messages) {
      const text = isSource ? message.message : (message.translations[locale] ?? '');
      const previous = merged.get(message.id);
      if (!previous) {
        merged.set(message.id, {id: message.id, message: text, description: [], references: message.references});
        continue;
      }
      // A translation already on disk wins over the carried-over one; references are unioned.
      const seen = new Set(previous.references.map((ref) => `${ref.path}:${ref.line ?? ''}`));
      merged.set(message.id, {
        ...previous,
        message: isSource ? text : previous.message || text,
        references: [
          ...previous.references,
          ...message.references.filter((ref) => !seen.has(`${ref.path}:${ref.line}`))
        ]
      });
    }
    if (isSource) {
      for (const [id, message] of merged) sourceMessagesById.set(id, message);
    }

    fs.writeFileSync(file, codec.encode([...merged.values()], {locale, sourceMessagesById}));
  }
}
