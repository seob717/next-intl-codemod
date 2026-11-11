# Changelog

## 0.1.4 (2026-11-11)

- Docs: how to point next-intl at the new catalogs after running the codemod, including a deep merge
  of the old and new catalogs while skipped bindings still read the old one.

## 0.1.3 (2026-11-09)

- Files other than `.ts`, `.tsx`, `.js` and `.jsx`, and optional calls such as `t?.('key')`, are no
  longer converted; optional calls are listed in the report. next-intl's extractor does not see
  them, so converting them dropped their messages from the catalogs.
- An old key reachable from several namespaces now keeps a separate id per namespace instead of
  collapsing into one.

## 0.1.2 (2026-11-09)

- Stops when `--format json` would write into the folder of the old catalogs. The extractor deletes
  keys it can't find in the code, including the ones skipped calls still need.

## 0.1.1 (2026-11-09)

- Stops when the installed next-intl is older than 4.14.0 and the output format is `po`. Older
  extractors erase the translations of a catalog in the new PO layout on the next `next dev` or
  `next build`.

## 0.1.0 (2026-11-08)

- First release: rewrites static `useTranslations` / `getTranslations` calls to `useExtracted` /
  `getExtracted`, carries existing translations over to the extraction catalogs, keeps explicit ids
  for conflicting translations and reports what it cannot convert.
- Stops before changing anything when a `.po` catalog in `--out` uses the previous next-intl layout.
