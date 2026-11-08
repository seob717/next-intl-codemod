# next-intl-codemod

Migrates a Next.js app from `useTranslations` / `getTranslations` with hand-written keys to
[`useExtracted` / `getExtracted`](https://next-intl.dev/docs/usage/extraction) with inline messages,
and carries the existing translations over so nothing has to be translated again.

```sh
npx next-intl-codemod --messages 'messages/{locale}.json' --source-locale en
```

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
   translations filled in. An existing extraction catalog is merged, never overwritten.
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

## Choosing the source locale

Inline messages are written in one locale and that locale must be the `messages.sourceLocale` of
your next-intl config. Pick the language your developers write copy in; it does not have to be
English. Texts are normalized to NFC before they are written, because ids hash the bytes as written
and editors save NFC: a decomposed catalog text would otherwise get a new id on its first save.
Keys whose text was normalized are listed under `normalizedKeys` in the report.

Run the codemod against the most complete catalog you have: keys missing from the source-locale
catalog cannot be inlined and are reported as `missing-key`.

## After running

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

## Verification

The codemod was validated against a real migration of a production app (2,109 keys, 352 files):

- running next-intl's extractor over the converted sources reproduces the written catalogs byte for byte;
- every migrated key resolves to a catalog entry whose translations equal the old ones, in every locale;
- fixtures in `test/` cover the rewrite rules, conflicts, skipping and import handling.
