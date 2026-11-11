# next-intl-codemod

Migrates a Next.js app from `useTranslations` / `getTranslations` with hand-written keys to
[`useExtracted` / `getExtracted`](https://next-intl.dev/docs/usage/extraction) with inline messages,
and carries the existing translations over so nothing has to be translated again.

```sh
npx next-intl-codemod --messages 'messages/{locale}.json' --source-locale en
```

The codemod rewrites source files in place, so run it on a clean working tree:

1. Commit or stash your changes.
2. Preview with `--dry-run --report report.json`. Nothing is written except the report.
3. Run it for real, then review the diff with `git diff`.

## What it does

For every `t` that is bound to one of the old hooks and only ever called with static keys:

```tsx
// before
import {useTranslations} from 'next-intl';
const t = useTranslations('Checkout');
t('title');
t.rich('terms', {link: (chunks) => <a>{chunks}</a>});

// after
import {useExtracted} from 'next-intl';
const t = useExtracted();
t('Checkout');
t.rich('Please accept the <link>terms</link>.', {link: (chunks) => <a>{chunks}</a>});
```

1. The key is replaced by the source-locale text from your catalogs. Ids are generated exactly like
   the extractor does (SHA-512, base64url, 6 chars), so a later `next dev` / `next build` leaves the
   catalogs untouched.
2. Catalogs for all locales are written in the extraction format (`po` or `json`) with the old
   translations filled in. An existing extraction catalog is merged, never overwritten. A `.po`
   catalog in the previous next-intl layout (keys in `msgid`) stops the run before anything changes.
3. If one source text was translated differently under different keys, each distinct translation set
   keeps its own message with an explicit id (the old key), so no translation is lost:
   ```tsx
   t({id: 'pricing.enterprise.seats', message: 'Unlimited'});
   ```
4. Everything the extractor cannot handle is left untouched and listed in the report: dynamic keys
   (`t(key)`, `t(\`a.${b}\`)`), dynamic namespaces, `t.raw`, `t.has`, `t` passed to another function
   or returned, keys missing from the catalogs. The old hook import stays as long as one binding in the
   file still needs it.

## Options

| Option | Default | |
| --- | --- | --- |
| `--messages <pattern>` | required | Old catalogs. `{locale}` is required, `*` matches several files per locale that are merged: `messages/{locale}.json`, `locales/{locale}/*.json` |
| `--source-locale <locale>` | required | Locale whose texts become the inline messages |
| `--src <dir>` | `src` | Source directory, repeatable |
| `--out <dir>` | `messages` | Where the extraction catalogs are written (`<locale>.po` / `.json`) |
| `--format po\|json` | `po` | |
| `--namespace none\|first-segment\|keep` | `none` | `first-segment` uses the first segment of the old key (`Checkout.title` → `useExtracted('Checkout')`), `keep` the namespace the old hook was called with |
| `--project-root <dir>` | cwd | Base for the `#:` references |
| `--dry-run` | | Report only |
| `--report <file>` | | JSON report: skipped bindings with reasons, conflicts, old keys never referenced, and `keyMap` (old key → new id) |

## Output

A run prints a summary. This one is from a dry run on two components, one of which passes a dynamic
key:

```
files: 1/2 changed
bindings: 1 converted, 1 skipped
calls: 2 converted
messages: 2 (0 with explicit ids from 0 conflicting texts)
old keys never referenced statically: 2
skipped because:
  1× dynamic-key
report: report.json
```

`report.json` points at each skipped binding and maps the migrated keys to their new ids (shortened):

```json
{
  "skipped": [
    {
      "file": "src/b.tsx",
      "name": "t",
      "line": 2,
      "column": 55,
      "problems": [{"reason": "dynamic-key", "line": 2, "column": 102}]
    }
  ],
  "unreferencedKeys": ["Checkout.status.ok", "Checkout.status.fail"],
  "keyMap": {"Checkout.title": "BJ2TKX", "Checkout.pay": "7tOz-m"}
}
```

## Requirements

The `po` format needs **next-intl 4.14.0 or newer**. That release changed the PO layout, and older
extractors erase the translations of a catalog in the new layout on the next `next dev` or
`next build`, so the codemod stops if it finds an older version. In a monorepo, upgrade every
workspace package to the same version and migrate any other PO catalog that next-intl loads, such as
a shared package's. The codemod only checks the catalogs in `--out`.

With `--format json`, `--out` must differ from the folder of the old catalogs: the extractor deletes
keys it can't find in the code, including the ones calls that were skipped still need. The codemod
stops if they overlap.

## Choosing the source locale

Inline messages are written in one locale and that locale must be the `messages.sourceLocale` of
your next-intl config. Pick the language your developers write copy in; it does not have to be
English. Texts are normalized to NFC before they are written, because ids hash the bytes as written
and editors save NFC: a decomposed catalog text would otherwise get a new id on its first save.
Keys whose text was normalized are listed under `normalizedKeys` in the report.

A key with no translation in a target locale gets an empty entry, which renders as an empty string
rather than next-intl's missing-message fallback.

Only `.ts`, `.tsx`, `.js` and `.jsx` files are converted, because those are the files next-intl's
extractor scans.

Run the codemod against the most complete catalog you have: keys missing from the source-locale
catalog cannot be inlined and are reported as `missing-key`.

## After running

The codemod only touches source files and catalogs. Before the app runs, point next-intl at the new
catalogs.

1. Enable extraction in `next.config.ts`, with the same `--out`, `--format` and `--source-locale`
   you passed to the codemod:

   ```ts
   import createNextIntlPlugin from 'next-intl/plugin';

   const withNextIntl = createNextIntlPlugin({
     experimental: {
       srcPath: './src',
       extract: true,
       messages: {path: './messages', format: 'po', locales: 'infer', sourceLocale: 'en'}
     }
   });

   export default withNextIntl({});
   ```

2. Load both catalogs in `i18n/request.ts` as long as skipped bindings still read the old one. Merge
   them deeply: an explicit id such as `Nav.home` arrives as `{Nav: {home}}`, so a shallow spread
   would replace the old `Nav` namespace and break skipped calls like `t('about')` on it.

   ```ts
   type Messages = {[key: string]: string | Messages};

   function merge(a: Messages, b: Messages): Messages {
     const result = {...a};
     for (const [key, value] of Object.entries(b)) {
       const prev = result[key];
       result[key] =
         typeof prev === 'object' && typeof value === 'object' ? merge(prev, value) : value;
     }
     return result;
   }

   export default getRequestConfig(async ({requestLocale}) => {
     // …resolve `locale` as before
     return {
       locale,
       messages: merge(
         (await import(`../../messages/${locale}.json`)).default, // old catalog
         (await import(`../../messages/${locale}.po`)).default // written by the codemod
       )
     };
   });
   ```

   Once the report has no skipped bindings left, drop the old catalog and import the `.po` file only.

Then:

- Review the report. Dynamic keys usually become a `switch` or an object literal of `t('…')` calls
  inside the component, as described in [static analysis](https://next-intl.dev/docs/usage/extraction#static-analysis).
- Old catalogs are not modified. Delete the migrated keys (or the files) once no binding reads them;
  `unreferencedKeys` in the report lists keys that no static call references.
- Run `tsc`. `useExtracted` types `values` from the inline message, which is stricter than
  catalog-based types, so two kinds of pre-existing looseness surface as errors:
  - Values or tag handlers the source text does not declare but a translation uses (e.g. a `<br>`
    only the English text has), and tag handlers passed to a plain `t()` call. These calls are
    listed under `valuesNotInMessage` in the report. Add the tag or argument to the source text, or
    switch to `t.rich`; removing the value would break the translation.
  - Numbers passed to a plain `{arg}`, which is typed as `string`. Use `{arg, number}` in the
    message (which also formats the number) or pass a string.
- Run the app once: the extractor rewrites nothing if the migration is consistent.

## With an AI coding agent

Agents can migrate files one by one, but carrying every translation over and deciding when one text
needs explicit ids is easy to get subtly wrong across hundreds of files. Let the codemod do that part
deterministically, then hand the agent what is left:

```
Run `npx next-intl-codemod --messages 'messages/{locale}.json' --source-locale en --report report.json`.
Then go through report.json: rewrite each binding under `skipped` so its keys are static, as described
in https://next-intl.dev/docs/usage/extraction#static-analysis, fix the `tsc` errors for the calls
under `valuesNotInMessage`, and run the codemod again until nothing is skipped.
```

## Verification

The codemod was validated on two production apps:

- running next-intl's extractor over the converted sources reproduces the written catalogs byte for byte;
- every migrated key resolves to a catalog entry whose translations equal the old ones, in every locale;
- fixtures in `test/` cover the rewrite rules, conflicts, skipping and import handling.

## Feedback

If a call is converted incorrectly or skipped when it shouldn't be, please
[open an issue](https://github.com/seob717/next-intl-codemod/issues) with the code snippet and the
matching entry from `report.json`. See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.
