#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {applyEdits, assertCatalogsSupported, assertNextIntlSupportsPo, type CatalogFormat, writeCatalogs} from './apply.js';
import {loadCatalogs} from './catalog.js';
import {collectSourceFiles} from './files.js';
import {buildPlan, type NamespaceStrategy} from './plan.js';
import {scanFiles} from './scan.js';

const {values} = parseArgs({
  options: {
    src: {type: 'string', multiple: true, default: ['src']},
    messages: {type: 'string'},
    'source-locale': {type: 'string'},
    out: {type: 'string', default: 'messages'},
    format: {type: 'string', default: 'po'},
    namespace: {type: 'string', default: 'none'},
    'project-root': {type: 'string', default: process.cwd()},
    'dry-run': {type: 'boolean', default: false},
    report: {type: 'string'},
    help: {type: 'boolean', default: false}
  }
});

if (values.help || !values.messages || !values['source-locale']) {
  console.log(`Usage: next-intl-codemod --messages <pattern> --source-locale <locale> [options]

Rewrites useTranslations/getTranslations calls with static keys to useExtracted/getExtracted
inline messages and carries the existing translations over to extraction catalogs.

  --messages <pattern>     Old catalogs, e.g. "messages/{locale}.json" or "locales/{locale}/*.json"
  --source-locale <locale> Locale whose texts become the inline messages
  --src <dir>              Source directory (repeatable, default: src)
  --out <dir>              Where to write the extraction catalogs (default: messages)
  --format po|json         Catalog format (default: po)
  --namespace none|first-segment|keep
                           none: useExtracted(); first-segment: first key segment;
                           keep: the namespace the old hook used (default: none)
  --project-root <dir>     Base for file references (default: cwd)
  --dry-run                Plan and report only
  --report <file>          Write the JSON report here`);
  process.exit(values.help ? 0 : 1);
}

const projectRoot = path.resolve(values['project-root']);
const format = values.format as CatalogFormat;
const namespace = values.namespace as NamespaceStrategy;
if (!['po', 'json'].includes(format)) throw new Error(`Unknown format: ${format}`);
if (!['none', 'first-segment', 'keep'].includes(namespace)) throw new Error(`Unknown namespace strategy: ${namespace}`);

assertNextIntlSupportsPo({projectRoot, format});
const catalogs = loadCatalogs(values.messages, projectRoot, values['source-locale']);
assertCatalogsSupported({outDir: path.resolve(projectRoot, values.out), format, locales: catalogs.locales});
const files: Array<string> = [];
for (const dir of values.src) collectSourceFiles(path.resolve(projectRoot, dir), files);
const scanned = scanFiles(files);
const plan = buildPlan(scanned, catalogs, {projectRoot, sourceLocale: values['source-locale'], namespace});

const {report} = plan;
console.log(
  [
    `files: ${report.files.changed}/${report.files.scanned} changed`,
    `bindings: ${report.bindings.converted} converted, ${report.bindings.skipped} skipped`,
    `calls: ${report.calls.converted} converted`,
    `messages: ${report.messages.total} (${report.messages.explicitIds} with explicit ids from ${report.conflicts.length} conflicting texts)`,
    `old keys never referenced statically: ${report.unreferencedKeys.length}`
  ].join('\n')
);
const reasons = new Map<string, number>();
for (const binding of report.skipped) {
  for (const problem of binding.problems) {
    const reason = problem.reason.split(':')[0];
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
}
if (reasons.size > 0) {
  console.log('skipped because:');
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${count}× ${reason}`);
}

if (values.report) {
  fs.writeFileSync(values.report, JSON.stringify(report, null, 2));
  console.log(`report: ${values.report}`);
}

if (report.valuesNotInMessage.length > 0) {
  console.log(`calls passing values the source text does not declare (expect tsc errors, see report): ${report.valuesNotInMessage.length}`);
}
if (report.files.withoutNextIntlImport.length > 0) {
  console.log(`files mentioning the hooks without a next-intl import (left untouched): ${report.files.withoutNextIntlImport.length}`);
}

if (!values['dry-run']) {
  applyEdits(plan.edits, new Map(scanned.map((scannedFile) => [scannedFile.file, scannedFile.text])));
  writeCatalogs(plan.messages, {
    outDir: path.resolve(projectRoot, values.out),
    format,
    sourceLocale: values['source-locale'],
    locales: catalogs.locales
  });
  console.log(`wrote ${catalogs.locales.length} catalogs to ${values.out}`);
}
