import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {applyEdits, type CatalogFormat, writeCatalogs} from '../src/apply.js';
import {loadCatalogs} from '../src/catalog.js';
import {collectSourceFiles} from '../src/files.js';
import {buildPlan, type NamespaceStrategy} from '../src/plan.js';
import {scanFiles} from '../src/scan.js';

type Options = {
  sourceLocale?: string;
  messages?: string;
  namespace?: NamespaceStrategy;
  format?: CatalogFormat;
};

/** Writes `files` into a temp project, runs the whole codemod and returns readers for the result. */
export function run(files: Record<string, string>, options: Options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-intl-codemod-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, content);
  }
  const sourceLocale = options.sourceLocale ?? 'en';
  const catalogs = loadCatalogs(options.messages ?? 'messages/{locale}.json', root, sourceLocale);
  const scanned = scanFiles(collectSourceFiles(path.join(root, 'src')));
  const plan = buildPlan(scanned, catalogs, {
    projectRoot: root,
    sourceLocale,
    namespace: options.namespace ?? 'none'
  });
  applyEdits(plan.edits, new Map(scanned.map((scannedFile) => [scannedFile.file, scannedFile.text])));
  writeCatalogs(plan.messages, {
    outDir: path.join(root, 'extracted'),
    format: options.format ?? 'po',
    sourceLocale,
    locales: catalogs.locales
  });
  return {
    root,
    report: plan.report,
    read: (name: string) => fs.readFileSync(path.join(root, name), 'utf8'),
    /** PO entries without the header, as `msgctxt|msgid|msgstr` lines, for compact assertions. */
    entries: (name: string) =>
      fs
        .readFileSync(path.join(root, name), 'utf8')
        .split('\n\n')
        .slice(1)
        .map((block) =>
          ['msgctxt', 'msgid', 'msgstr']
            .map((field) => block.match(new RegExp(`^${field} "(.*)"$`, 'm'))?.[1] ?? '')
            .join('|')
        )
  };
}
