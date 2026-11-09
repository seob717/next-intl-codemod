import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {unstable_extractMessages} from 'next-intl/extractor';
import {describe, expect, it} from 'vitest';
import {generateId} from '../src/id.js';
import {run} from './run.js';

const en = JSON.stringify({Home: {title: 'Hello', body: 'Welcome <b>home</b>', cta: 'Start'}, About: {title: 'About'}});
const de = JSON.stringify({Home: {title: 'Hallo', body: 'Willkommen <b>zuhause</b>', cta: 'Los'}, About: {title: 'Über'}});
const HELLO = generateId('Hello');

describe('useTranslations', () => {
  it('rewrites static keys to inline messages and carries translations over', () => {
    const {read, entries} = run({
      'messages/en.json': en,
      'messages/de.json': de,
      'src/Home.tsx': `import {useTranslations} from 'next-intl';
export default function Home() {
  const t = useTranslations('Home');
  return <h1 title={t('cta')}>{t('title')}</h1>;
}
`
    });
    expect(read('src/Home.tsx')).toBe(`import {useExtracted} from 'next-intl';
export default function Home() {
  const t = useExtracted();
  return <h1 title={t('Start')}>{t('Hello')}</h1>;
}
`);
    expect(entries('extracted/en.po')).toEqual([`${generateId('Start')}|Start|Start`, `${HELLO}|Hello|Hello`]);
    expect(entries('extracted/de.po')).toEqual([`${generateId('Start')}|Start|Los`, `${HELLO}|Hello|Hallo`]);
    expect(read('extracted/en.po')).toContain('#: src/Home.tsx\n');
  });

  it('keeps the first key segment as namespace with --namespace first-segment', () => {
    const {read, entries} = run(
      {
        'messages/en.json': en,
        'messages/de.json': de,
        'src/Home.tsx': `import {useTranslations} from 'next-intl';
const t = useTranslations();
t('Home.title');
`
      },
      {namespace: 'first-segment'}
    );
    expect(read('src/Home.tsx')).toContain(`const t = useExtracted('Home');`);
    expect(entries('extracted/de.po')).toEqual([`Home.${HELLO}|Hello|Hallo`]);
  });

  it('keeps t.rich values and converts the message only', () => {
    const {read} = run({
      'messages/en.json': en,
      'messages/de.json': de,
      'src/Home.tsx': `import {useTranslations} from 'next-intl';
const t = useTranslations('Home');
t.rich('body', {b: (chunks) => <b>{chunks}</b>});
`
    });
    expect(read('src/Home.tsx')).toContain(`t.rich('Welcome <b>home</b>', {b: (chunks) => <b>{chunks}</b>});`);
  });

  it('escapes quotes and newlines in the inline message', () => {
    const {read} = run({
      'messages/en.json': JSON.stringify({a: "It's\nfine"}),
      'src/A.tsx': `import {useTranslations} from 'next-intl';
const t = useTranslations();
t('a');
`
    });
    expect(read('src/A.tsx')).toContain(`t('It\\'s\\nfine');`);
  });
});

describe('getTranslations', () => {
  it('rewrites the object form and Promise.all destructuring', () => {
    const {read} = run(
      {
        'messages/en.json': en,
        'messages/de.json': de,
        'src/page.tsx': `import {getTranslations} from 'next-intl/server';
export default async function Page({params}) {
  const {locale} = await params;
  const t = await getTranslations({locale, namespace: 'Home'});
  const [a, b] = await Promise.all([getTranslations('Home'), getTranslations('About')]);
  return t('title') + a('cta') + b('title');
}
`
      },
      {namespace: 'keep'}
    );
    expect(read('src/page.tsx')).toBe(`import {getExtracted} from 'next-intl/server';
export default async function Page({params}) {
  const {locale} = await params;
  const t = await getExtracted({locale, namespace: 'Home'});
  const [a, b] = await Promise.all([getExtracted('Home'), getExtracted('About')]);
  return t('Hello') + a('Start') + b('About');
}
`);
  });

  it('drops the namespace property when the strategy is none', () => {
    const {read} = run({
      'messages/en.json': en,
      'src/page.tsx': `import {getTranslations} from 'next-intl/server';
const t = await getTranslations({locale: 'en', namespace: 'Home'});
t('title');
`
    });
    expect(read('src/page.tsx')).toContain(`const t = await getExtracted({locale: 'en'});`);
  });
});

describe('conflicts', () => {
  it('keeps an explicit id per distinct translation set when one source text had several translations', () => {
    const {read, entries, report} = run({
      'messages/en.json': JSON.stringify({a: {save: 'Save'}, b: {save: 'Save'}, c: {save: 'Save'}}),
      'messages/de.json': JSON.stringify({a: {save: 'Speichern'}, b: {save: 'Sichern'}, c: {save: 'Speichern'}}),
      'src/A.tsx': `import {useTranslations} from 'next-intl';
const t = useTranslations();
t('a.save');
t.rich('b.save', {});
t('c.save');
`
    });
    expect(read('src/A.tsx')).toContain(`t({id: 'a.save', message: 'Save'});`);
    expect(read('src/A.tsx')).toContain(`t.rich({id: 'b.save', message: 'Save'}, {});`);
    expect(read('src/A.tsx')).toContain(`t({id: 'a.save', message: 'Save'});\nt.rich`);
    expect(entries('extracted/de.po')).toEqual(['a.save|Save|Speichern', 'b.save|Save|Sichern']);
    expect(report.conflicts).toHaveLength(1);
    expect(report.keyMap).toEqual({'a.save': 'a.save', 'b.save': 'b.save', 'c.save': 'a.save'});
  });

  it('merges identical translations into one auto id', () => {
    const {entries} = run({
      'messages/en.json': JSON.stringify({a: {save: 'Save'}, b: {save: 'Save'}}),
      'messages/de.json': JSON.stringify({a: {save: 'Speichern'}, b: {save: 'Speichern'}}),
      'src/A.tsx': `import {useTranslations} from 'next-intl';
const t = useTranslations();
t('a.save');
t('b.save');
`
    });
    expect(entries('extracted/de.po')).toEqual([`${generateId('Save')}|Save|Speichern`]);
  });
});

describe('skipping', () => {
  it('leaves a binding with a dynamic key untouched and keeps both imports', () => {
    const {read, report} = run({
      'messages/en.json': en,
      'src/A.tsx': `import {useTranslations} from 'next-intl';
export function A({key}) {
  const t = useTranslations('Home');
  const other = useTranslations('About');
  return t(key) + other('title');
}
`
    });
    expect(read('src/A.tsx')).toBe(`import {useTranslations, useExtracted} from 'next-intl';
export function A({key}) {
  const t = useTranslations('Home');
  const other = useExtracted();
  return t(key) + other('About');
}
`);
    expect(report.skipped).toMatchObject([{name: 't', problems: [{reason: 'dynamic-key', line: 5}]}]);
  });

  it('reports missing keys, t.raw and translators that escape the call site', () => {
    const {read, report} = run({
      'messages/en.json': en,
      'src/A.tsx': `import {useTranslations} from 'next-intl';
const t = useTranslations('Home');
t('nope');
const raw = useTranslations('Home');
raw.raw('title');
const passed = useTranslations('Home');
helper(passed);
const ns = useTranslations();
ns('Home');
const deps = useTranslations('Home');
useCallback(() => deps('title'), [deps]);
`
    });
    expect(read('src/A.tsx')).toContain(`import {useTranslations, useExtracted} from 'next-intl';`);
    expect(read('src/A.tsx')).toContain(`const deps = useExtracted();\nuseCallback(() => deps('Hello'), [deps]);`);
    expect(report.skipped.map((s) => s.problems[0].reason)).toEqual([
      'missing-key: Home.nope',
      't.raw-not-supported-by-extraction',
      'translator-used-outside-call',
      'key-refers-to-namespace-object: Home'
    ]);
    expect(report.unreferencedKeys).toContain('Home.body');
  });

  it('skips dynamic namespaces without repeating the problem per call', () => {
    const {report} = run({
      'messages/en.json': en,
      'src/A.tsx': `import {useTranslations} from 'next-intl';
const t = useTranslations(ns);
t('title');
t('cta');
`
    });
    expect(report.skipped[0].problems).toEqual([{reason: 'dynamic-namespace', line: 2, column: 10}]);
  });
});

describe('edge cases', () => {
  it('gives single-segment keys no namespace under first-segment', () => {
    const {read} = run(
      {
        'messages/en.json': JSON.stringify({hello: 'Hi', Home: {title: 'Hello'}}),
        'src/A.tsx': `import {useTranslations} from 'next-intl';
const a = useTranslations();
a('hello');
const b = useTranslations();
b('hello');
b('Home.title');
`
      },
      {namespace: 'first-segment'}
    );
    expect(read('src/A.tsx')).toContain(`const a = useExtracted();\na('Hi');\nconst b = useExtracted();`);
  });

  it('reports files that import the hooks from somewhere else and skips empty messages', () => {
    const {read, report} = run({
      'messages/en.json': JSON.stringify({a: '', b: 'B'}),
      'src/A.tsx': `import {useTranslations} from '@/i18n';
const t = useTranslations();
t('b');
`,
      'src/B.tsx': `import {useTranslations} from 'next-intl';
const t = useTranslations();
t('a');
`
    });
    expect(report.files.withoutNextIntlImport).toEqual(['src/A.tsx']);
    expect(read('src/A.tsx')).toContain(`t('b');`);
    expect(report.skipped[0].problems[0].reason).toBe('empty-message: a');
  });

  it('handles two import declarations and an import that is also used as a value', () => {
    const {read} = run({
      'messages/en.json': en,
      'src/A.tsx': `import {useLocale} from 'next-intl';
import {useTranslations} from 'next-intl';
const t = useTranslations('Home');
t('title');
`,
      'src/B.tsx': `import {useTranslations} from 'next-intl';
export const hooks = {useTranslations};
const t = useTranslations('Home');
t('title');
`
    });
    expect(read('src/A.tsx')).toContain(`import {useLocale} from 'next-intl';\nimport {useExtracted} from 'next-intl';\nconst t = useExtracted();`);
    expect(read('src/B.tsx')).toContain(`import {useTranslations, useExtracted} from 'next-intl';\nexport const hooks = {useTranslations};\nconst t = useExtracted();`);
  });

  it('keeps a BOM and counts columns in code points', () => {
    const {read, report} = run({
      'messages/en.json': en,
      'src/A.tsx': `﻿import {useTranslations} from 'next-intl';
const t = useTranslations('Home');
const x = '😀' + t('title') + t('cta');
`
    });
    expect(read('src/A.tsx')).toBe(`﻿import {useExtracted} from 'next-intl';
const t = useExtracted();
const x = '😀' + t('Hello') + t('Start');
`);
    expect(read('extracted/en.po').indexOf('msgid "Hello"')).toBeLessThan(read('extracted/en.po').indexOf('msgid "Start"'));
    expect(report.files.changed).toBe(1);
  });

  it('normalizes decomposed source text to NFC, escapes control characters and skips blank messages', () => {
    const nfd = 'Café Hà';
    const {read, report, entries} = run({
      'messages/en.json': JSON.stringify({cafe: nfd, bell: 'Ring\u0007', blank: '  '}),
      'messages/de.json': JSON.stringify({cafe: 'Café'}),
      'src/A.tsx': `import {useTranslations} from 'next-intl';
const t = useTranslations();
t('cafe');
t('bell');
const u = useTranslations();
u('blank');
`
    });
    const nfc = nfd.normalize('NFC');
    expect(read('src/A.tsx')).toContain(`t('${nfc}');\nt('Ring\\u0007');`);
    expect(entries('extracted/de.po')).toContain(`${generateId(nfc)}|${nfc}|Café`);
    expect(report.normalizedKeys).toEqual(['cafe']);
    expect(report.skipped[0].problems[0].reason).toBe('empty-message: blank');
  });

  it('reports values and tag handlers the source text does not declare', () => {
    const {report} = run({
      'messages/en.json': JSON.stringify({plain: 'Hello', rich: 'Hi <b>{name}</b>, {count, plural, one {# item} other {# items}}'}),
      'src/A.tsx': `import {useTranslations} from 'next-intl';
const t = useTranslations();
t.rich('plain', {br: () => <br />});
t.rich('rich', {b: (chunks) => <b>{chunks}</b>, name, count: 2});
t('plain', values);
t('rich', {b: 1, name, count: 2});
`
    });
    expect(report.valuesNotInMessage).toEqual([
      {file: 'src/A.tsx', line: 3, column: 0, key: 'plain', values: ['br']},
      {file: 'src/A.tsx', line: 6, column: 0, key: 'rich', values: ['b']}
    ]);
  });

  it('is idempotent and skips destructured hook results', () => {
    const files = {
      'messages/en.json': en,
      'messages/de.json': de,
      'src/A.tsx': `import {useTranslations} from 'next-intl';
const t = useTranslations('Home');
t('title');
const {rich} = useTranslations('Home');
rich('body');
`
    };
    const first = run(files);
    const converted = {
      ...files,
      'src/A.tsx': first.read('src/A.tsx'),
      'extracted/en.po': first.read('extracted/en.po'),
      'extracted/de.po': first.read('extracted/de.po')
    };
    const second = run(converted);
    expect(second.read('src/A.tsx')).toBe(first.read('src/A.tsx'));
    expect(second.read('extracted/de.po')).toBe(first.read('extracted/de.po'));
    expect(first.report.skipped[0].problems[0].reason).toBe('hook-result-not-bound-to-variable');
    // Still something to migrate: an existing catalog is merged, not rebuilt.
    const third = run({...converted, 'src/B.tsx': `import {useTranslations} from 'next-intl';
const t = useTranslations('About');
t('title');
`});
    expect(third.entries('extracted/de.po')).toEqual([`${HELLO}|Hello|Hallo`, `${generateId('About')}|About|Über`]);
  });
});

describe('imports', () => {
  it('keeps an alias and reuses an existing useExtracted import', () => {
    const {read} = run({
      'messages/en.json': en,
      'src/A.tsx': `import {useTranslations as useT} from 'next-intl';
const t = useT('Home');
t('title');
`,
      'src/B.tsx': `import {useExtracted as useX, useTranslations} from 'next-intl';
const t = useTranslations('Home');
t('title');
`
    });
    expect(read('src/A.tsx')).toContain(`import {useExtracted as useT} from 'next-intl';\nconst t = useT();`);
    expect(read('src/B.tsx')).toBe(`import {useExtracted as useX} from 'next-intl';
const t = useX();
t('Hello');
`);
  });
});

describe('extractor round trip', () => {
  const messages = {
    plural: '{count, plural, =0 {none} one {# item} other {# items}}',
    select: '{gender, select, female {She} other {They}} left',
    apostrophe: "It''s {name}",
    literal: "Use '{braces}' here",
    rich: 'Read <b>the {thing}</b> now',
    quotes: 'Say "hi"',
    single: "Don't stop",
    backslash: 'a\\b',
    newline: 'one\ntwo',
    spaces: '  padded  ',
    emoji: 'Hi 👋🏽'
  };
  const translated = Object.fromEntries(Object.entries(messages).map(([key, value]) => [key, `${value} [de]`]));
  const calls = Object.keys(messages)
    .map((key) => `t('${key}', {count: 1, gender: 'female', name: 'A', thing: 'B', b: (c) => c});`)
    .join('\n');

  for (const format of ['po', 'json'] as const) {
    it(`leaves ${format} catalogs untouched`, async () => {
      const {root, read} = run(
        {
          'messages/en.json': JSON.stringify({Home: messages}),
          'messages/de.json': JSON.stringify({Home: translated}),
          'src/A.tsx': `import {useTranslations} from 'next-intl';\nconst t = useTranslations('Home');\n${calls}\n`
        },
        {format}
      );
      const files = [`extracted/en.${format}`, `extracted/de.${format}`];
      const before = files.map(read);
      expect(before[1]).toContain('[de]');

      const cwd = process.cwd();
      process.chdir(root);
      try {
        await unstable_extractMessages({
          srcPath: 'src',
          messages: {format, path: 'extracted', locales: ['en', 'de'], sourceLocale: 'en'},
          extract: true
        });
      } finally {
        process.chdir(cwd);
      }
      expect(files.map(read)).toEqual(before);
    });
  }
});

describe('cli', () => {
  it('stops before changing anything when json output would land on the old catalogs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-intl-codemod-'));
    const source = `import {useTranslations} from 'next-intl';\nconst t = useTranslations('Home');\nt('title');\n`;
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'messages'));
    fs.writeFileSync(path.join(root, 'src/A.tsx'), source);
    fs.writeFileSync(path.join(root, 'messages/en.json'), en);
    const args = ['--import', 'tsx', 'src/cli.ts', '--project-root', root, '--messages', 'messages/{locale}.json', '--source-locale', 'en', '--format', 'json'];

    expect(() => execFileSync(process.execPath, args, {stdio: 'pipe'})).toThrow(/one of the old catalogs/);
    expect(fs.readFileSync(path.join(root, 'src/A.tsx'), 'utf8')).toBe(source);
    expect(fs.readFileSync(path.join(root, 'messages/en.json'), 'utf8')).toBe(en);

    execFileSync(process.execPath, [...args, '--out', 'extracted'], {stdio: 'pipe'});
    expect(fs.readFileSync(path.join(root, 'messages/en.json'), 'utf8')).toBe(en);
    expect(fs.existsSync(path.join(root, 'extracted/en.json'))).toBe(true);
  });

  it('stops before changing anything when next-intl is too old for PO catalogs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-intl-codemod-'));
    const source = `import {useTranslations} from 'next-intl';\nconst t = useTranslations('Home');\nt('title');\n`;
    fs.mkdirSync(path.join(root, 'app/src'), {recursive: true});
    fs.mkdirSync(path.join(root, 'app/messages'));
    fs.mkdirSync(path.join(root, 'node_modules/next-intl'), {recursive: true});
    fs.writeFileSync(path.join(root, 'app/src/A.tsx'), source);
    fs.writeFileSync(path.join(root, 'app/messages/en.json'), en);
    const setVersion = (version: string) =>
      fs.writeFileSync(path.join(root, 'node_modules/next-intl/package.json'), JSON.stringify({version}));
    const args = ['--import', 'tsx', 'src/cli.ts', '--project-root', path.join(root, 'app'), '--messages', 'messages/{locale}.json', '--source-locale', 'en'];

    setVersion('4.13.7');
    expect(() => execFileSync(process.execPath, args, {stdio: 'pipe'})).toThrow(/next-intl 4\.13\.7 is installed/);
    expect(fs.readFileSync(path.join(root, 'app/src/A.tsx'), 'utf8')).toBe(source);
    expect(fs.existsSync(path.join(root, 'app/messages/en.po'))).toBe(false);

    setVersion('4.14.0');
    execFileSync(process.execPath, args, {stdio: 'pipe'});
    expect(fs.existsSync(path.join(root, 'app/messages/en.po'))).toBe(true);
  });

  it('stops before changing anything when a catalog uses the previous PO layout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-intl-codemod-'));
    const source = `import {useTranslations} from 'next-intl';\nconst t = useTranslations('Home');\nt('title');\n`;
    const catalog = `msgid ""\nmsgstr ""\n"Language: en\\n"\n"X-Crowdin-SourceKey: msgstr\\n"\n`;
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'messages'));
    fs.writeFileSync(path.join(root, 'src/A.tsx'), source);
    fs.writeFileSync(path.join(root, 'messages/en.json'), en);
    fs.writeFileSync(path.join(root, 'messages/en.po'), catalog);

    const args = ['--import', 'tsx', 'src/cli.ts', '--project-root', root, '--messages', 'messages/{locale}.json', '--source-locale', 'en'];
    expect(() => execFileSync(process.execPath, args, {stdio: 'pipe'})).toThrow(/previous PO layout/);
    expect(fs.readFileSync(path.join(root, 'src/A.tsx'), 'utf8')).toBe(source);
    expect(fs.readFileSync(path.join(root, 'messages/en.po'), 'utf8')).toBe(catalog);
  });
});

describe('catalogs', () => {
  it('reads namespace files and writes json catalogs', () => {
    const {read} = run(
      {
        'locales/en/Home.json': JSON.stringify({Home: {title: 'Hello'}}),
        'locales/de/Home.json': JSON.stringify({Home: {title: 'Hallo'}}),
        'src/A.tsx': `import {useTranslations} from 'next-intl';
const t = useTranslations('Home');
t('title');
`
      },
      {messages: 'locales/{locale}/*.json', format: 'json', namespace: 'first-segment'}
    );
    expect(JSON.parse(read('extracted/de.json'))).toEqual({Home: {[HELLO]: 'Hallo'}});
  });

  it('keeps translations already present in an existing catalog', () => {
    const {entries} = run({
      'messages/en.json': en,
      'messages/de.json': de,
      'extracted/de.po': `msgid ""
msgstr ""
"Language: de\\n"
"X-Message-Key: msgctxt\\n"

#: src/Old.tsx
msgctxt "${HELLO}"
msgid "Hello"
msgstr "Servus"
`,
      'src/A.tsx': `import {useTranslations} from 'next-intl';
const t = useTranslations('Home');
t('title');
`
    });
    expect(entries('extracted/de.po')).toEqual([`${HELLO}|Hello|Servus`]);
  });
});
