import path from 'node:path';
import type {LoadedCatalogs} from './catalog.js';
import {generateId} from './id.js';
import {
  type Binding,
  type CallSite,
  EXTRACTED_BY_HOOK,
  type HookKind,
  MODULE_BY_HOOK,
  type Problem,
  type ScannedFile
} from './scan.js';

export type NamespaceStrategy = 'none' | 'first-segment' | 'keep';

export type PlanOptions = {
  projectRoot: string;
  sourceLocale: string;
  namespace: NamespaceStrategy;
};

export type Edit = {file: string; start: number; end: number; text: string};

export type Reference = {path: string; line: number; column: number};

export type PlannedMessage = {
  id: string;
  message: string;
  references: Array<Reference>;
  /** Target locale -> translation carried over from the old catalogs. */
  translations: Record<string, string>;
  explicitId: boolean;
  oldKeys: Array<string>;
};

export type SkippedBinding = {
  file: string;
  name: string;
  hook: HookKind;
  line: number;
  column: number;
  problems: Array<Problem>;
};

export type Conflict = {
  namespace?: string;
  message: string;
  clusters: Array<{id: string; oldKeys: Array<string>; translations: Record<string, string>}>;
};

export type Report = {
  files: {
    scanned: number;
    changed: number;
    /** Files that mention the old hooks but import them from somewhere other than next-intl. */
    withoutNextIntlImport: Array<string>;
  };
  bindings: {converted: number; skipped: number};
  calls: {converted: number};
  messages: {total: number; explicitIds: number};
  /** Old keys whose source text was not in NFC and was normalized for the inline message and catalog. */
  normalizedKeys: Array<string>;
  /**
   * Calls that pass values or tag handlers the source text does not declare (a translation probably
   * does). Converted anyway; `useExtracted` types them from the inline message, so `tsc` flags them.
   */
  valuesNotInMessage: Array<{file: string; line: number; column: number; key: string; values: Array<string>}>;
  skipped: Array<SkippedBinding>;
  conflicts: Array<Conflict>;
  nonStringKeys: Array<string>;
  catalogCollisions: LoadedCatalogs['collisions'];
  /** Source-locale keys no static call referenced. Dynamic keys are not visible to the scan. */
  unreferencedKeys: Array<string>;
  /** Old key -> new catalog id, for every key the codemod migrated. */
  keyMap: Record<string, string>;
};

export type Plan = {edits: Array<Edit>; messages: Array<PlannedMessage>; report: Report};

export function toStringLiteral(text: string): string {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/[\u0000-\u001f\u007f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `'${escaped}'`;
}

type ResolvedCall = {call: CallSite; fullKey: string; text: string; normalized: boolean};

type GroupEntry = {
  fullKey: string;
  translations: Record<string, string>;
  sites: Array<{file: string; call: CallSite}>;
};

function resolveBinding(
  binding: Binding,
  catalogs: LoadedCatalogs,
  sourceLocale: string
): {resolved: Array<ResolvedCall>; problems: Array<Problem>} {
  const source = catalogs.byLocale.get(sourceLocale)!;
  const problems = [...binding.problems];
  const resolved: Array<ResolvedCall> = [];
  // Without a static namespace no key can be looked up; reporting each call would only repeat the cause.
  if (problems.some((problem) => problem.reason === 'dynamic-namespace')) return {resolved, problems};
  for (const call of binding.calls) {
    const fullKey = binding.namespace ? `${binding.namespace}.${call.key}` : call.key!;
    const raw = source.get(fullKey);
    // Ids hash the bytes as written. Editors save NFC, so a decomposed catalog text would get a new
    // id (and lose its translations) on the first save; normalize up front instead.
    const text = raw?.normalize('NFC');
    if (text !== undefined && text.trim() === '') {
      problems.push({reason: `empty-message: ${fullKey}`, line: call.line, column: call.column});
      continue;
    }
    if (text === undefined) {
      const reason = catalogs.nonString.has(fullKey)
        ? 'non-string-message'
        : [...source.keys()].some((key) => key.startsWith(`${fullKey}.`))
          ? 'key-refers-to-namespace-object'
          : 'missing-key';
      problems.push({reason: `${reason}: ${fullKey}`, line: call.line, column: call.column});
      continue;
    }
    resolved.push({call, fullKey, text, normalized: raw !== text});
  }
  return {resolved, problems};
}

function pickNamespace(
  binding: Binding,
  resolved: Array<ResolvedCall>,
  strategy: NamespaceStrategy
): string | undefined {
  if (strategy === 'none') return undefined;
  if (strategy === 'keep') return binding.namespace;
  // A single-segment key has no namespace to take; mixing it with namespaced keys yields none either.
  const firstSegments = new Set(
    resolved.map(({fullKey}) => (fullKey.includes('.') ? fullKey.split('.')[0] : undefined))
  );
  return firstSegments.size === 1 ? [...firstSegments][0] : undefined;
}

export function buildPlan(
  scanned: Array<ScannedFile>,
  catalogs: LoadedCatalogs,
  options: PlanOptions
): Plan {
  const targetLocales = catalogs.locales.filter((locale) => locale !== options.sourceLocale);
  const edits: Array<Edit> = [];
  const skipped: Array<SkippedBinding> = [];
  const referencedKeys = new Set<string>();
  const groups = new Map<string, {namespace?: string; text: string; entries: Map<string, GroupEntry>}>();
  // Call-site edits are emitted once ids are known, so remember where each call goes.
  const pendingCalls: Array<{file: string; call: CallSite; groupKey: string; fullKey: string}> = [];
  let convertedBindings = 0;
  let convertedCalls = 0;
  const changedFiles = new Set<string>();
  const normalizedKeys = new Set<string>();
  const valuesNotInMessage: Report['valuesNotInMessage'] = [];

  for (const scannedFile of scanned) {
    const {file, text} = scannedFile;
    // Per hook kind: which bindings stay on the old hook decides whether the
    // import is renamed or extended.
    const kept = new Set<HookKind>();
    const converted = new Set<HookKind>();
    const hookEdits: Array<{binding: Binding; namespace?: string}> = [];

    for (const binding of scannedFile.bindings) {
      const {resolved, problems} = resolveBinding(binding, catalogs, options.sourceLocale);
      for (const {fullKey} of resolved) referencedKeys.add(fullKey);
      if (problems.length > 0) {
        kept.add(binding.hook);
        const {line, column} = positionFromOffset(text, binding.hookCallRange.start);
        skipped.push({file: relative(options.projectRoot, file), name: binding.name, hook: binding.hook, line, column, problems});
        continue;
      }
      converted.add(binding.hook);
      convertedBindings++;
      const namespace = pickNamespace(binding, resolved, options.namespace);
      hookEdits.push({binding, namespace});

      for (const {call, fullKey, text: messageText, normalized} of resolved) {
        convertedCalls++;
        if (normalized) normalizedKeys.add(fullKey);
        if (call.valueKeys) {
          const {args, tags} = icuNames(messageText);
          // Tag handlers only exist on t.rich / t.markup; a plain t() call cannot take them.
          const declared = call.method === 'call' ? args : new Set([...args, ...tags]);
          const extra = call.valueKeys.filter((name) => !declared.has(name));
          if (extra.length > 0) {
            valuesNotInMessage.push({file: relative(options.projectRoot, file), line: call.line, column: call.column, key: fullKey, values: extra});
          }
        }
        const groupKey = `${namespace ?? ''}\u0000${messageText}`;
        let group = groups.get(groupKey);
        if (!group) {
          group = {namespace, text: messageText, entries: new Map()};
          groups.set(groupKey, group);
        }
        let entry = group.entries.get(fullKey);
        if (!entry) {
          const translations: Record<string, string> = {};
          for (const locale of targetLocales) {
            translations[locale] = catalogs.byLocale.get(locale)?.get(fullKey) ?? '';
          }
          entry = {fullKey, translations, sites: []};
          group.entries.set(fullKey, entry);
        }
        entry.sites.push({file, call});
        pendingCalls.push({file, call, groupKey, fullKey});
      }
    }

    if (hookEdits.length === 0) continue;
    changedFiles.add(file);

    for (const hook of converted) {
      const extractedName = EXTRACTED_BY_HOOK[hook];
      const oldName = hook === 'use' ? 'useTranslations' : 'getTranslations';
      const moduleImports = scannedFile.imports.filter((info) => info.module === MODULE_BY_HOOK[hook]);
      const importInfo =
        moduleImports.find((info) => info.specifiers.some((spec) => spec.imported === oldName)) ?? moduleImports[0];
      const existing = moduleImports.flatMap((info) => info.specifiers).find((spec) => spec.imported === extractedName);
      const hookSpecifier = importInfo?.specifiers.find((spec) => spec.imported === oldName);
      // The old specifier can go only when no binding and no other reference still needs it.
      const oldSpecifierUnused = hookSpecifier !== undefined && !kept.has(hook) && hookSpecifier.otherUses === 0;
      let localName = extractedName;
      if (existing) {
        localName = existing.local;
        if (oldSpecifierUnused) {
          // The old hook is no longer used: drop its specifier together with one separating comma.
          const specifiers = importInfo!.specifiers;
          const index = specifiers.indexOf(hookSpecifier);
          const start = index > 0 ? specifiers[index - 1].elementRange.end : hookSpecifier.elementRange.start;
          const end = index > 0 ? hookSpecifier.elementRange.end : specifiers[index + 1].elementRange.start;
          edits.push({file, start, end, text: ''});
        }
      } else if (oldSpecifierUnused) {
        // Every binding of this hook is converted: rename the specifier in place.
        edits.push({file, ...hookSpecifier.importedRange, text: extractedName});
        if (hookSpecifier.local !== hookSpecifier.imported) localName = hookSpecifier.local;
      } else if (importInfo) {
        edits.push({file, start: importInfo.appendPosition, end: importInfo.appendPosition, text: `, ${extractedName}`});
      }

      for (const {binding, namespace} of hookEdits) {
        if (binding.hook !== hook) continue;
        let args = '';
        if (binding.otherHookProps) {
          const props = [...binding.otherHookProps];
          if (namespace !== undefined) props.push(`namespace: ${toStringLiteral(namespace)}`);
          args = props.length > 0 ? `{${props.join(', ')}}` : '';
        } else if (namespace !== undefined) {
          args = toStringLiteral(namespace);
        }
        edits.push({file, ...binding.hookCallRange, text: `${localName}(${args})`});
      }
    }
  }

  // Resolve ids: one message per (namespace, text) unless the old translations
  // disagree, in which case each distinct translation set keeps an explicit id.
  const messages: Array<PlannedMessage> = [];
  const conflicts: Array<Conflict> = [];
  const idByFullKey = new Map<string, {localId: string; explicit: boolean}>();
  const usedIds = new Set<string>();

  for (const group of groups.values()) {
    const clusters = new Map<string, Array<GroupEntry>>();
    for (const entry of group.entries.values()) {
      const signature = JSON.stringify(targetLocales.map((locale) => entry.translations[locale]));
      const list = clusters.get(signature) ?? [];
      list.push(entry);
      clusters.set(signature, list);
    }
    const isConflict = clusters.size > 1;
    const conflict: Conflict = {namespace: group.namespace, message: group.text, clusters: []};
    const prefix = group.namespace ? `${group.namespace}.` : '';

    for (const entries of clusters.values()) {
      entries.sort((a, b) => a.fullKey.localeCompare(b.fullKey, 'en'));
      let localId = generateId(group.text);
      if (isConflict) {
        const first = entries[0].fullKey;
        localId = first.startsWith(prefix) ? first.slice(prefix.length) : first;
      }
      const id = `${prefix}${localId}`;
      if (usedIds.has(id)) throw new Error(`Generated id collision: ${id}`);
      usedIds.add(id);

      const references: Array<Reference> = [];
      for (const entry of entries) {
        idByFullKey.set(entry.fullKey, {localId, explicit: isConflict});
        for (const {file, call} of entry.sites) {
          references.push({path: relative(options.projectRoot, file), line: call.line, column: call.column});
        }
      }
      messages.push({
        id,
        message: group.text,
        references: references.sort(compareReferences),
        translations: entries[0].translations,
        explicitId: isConflict,
        oldKeys: entries.map((entry) => entry.fullKey)
      });
      conflict.clusters.push({id, oldKeys: entries.map((entry) => entry.fullKey), translations: entries[0].translations});
    }
    if (isConflict) conflicts.push(conflict);
  }

  for (const {file, call, fullKey, groupKey} of pendingCalls) {
    const {localId, explicit} = idByFullKey.get(fullKey)!;
    const text = groups.get(groupKey)!.text;
    const replacement = explicit
      ? `{id: ${toStringLiteral(localId)}, message: ${toStringLiteral(text)}}`
      : toStringLiteral(text);
    edits.push({file, ...call.argRange!, text: replacement});
  }

  const source = catalogs.byLocale.get(options.sourceLocale)!;
  const report: Report = {
    files: {
      scanned: scanned.length,
      changed: changedFiles.size,
      withoutNextIntlImport: scanned
        .filter((scannedFile) => scannedFile.imports.length === 0 && scannedFile.hookIdentifiers > 0)
        .map((scannedFile) => relative(options.projectRoot, scannedFile.file))
    },
    bindings: {converted: convertedBindings, skipped: skipped.length},
    calls: {converted: convertedCalls},
    messages: {total: messages.length, explicitIds: messages.filter((m) => m.explicitId).length},
    normalizedKeys: [...normalizedKeys],
    valuesNotInMessage,
    skipped,
    conflicts,
    nonStringKeys: [...catalogs.nonString.keys()],
    catalogCollisions: catalogs.collisions,
    unreferencedKeys: [...source.keys()].filter((key) => !referencedKeys.has(key)),
    keyMap: Object.fromEntries(messages.flatMap((m) => m.oldKeys.map((key) => [key, m.id])))
  };
  return {edits, messages, report};
}

/** Argument and tag names an ICU message declares: `{count, plural, …}`, `<link>…</link>`. */
function icuNames(message: string): {args: Set<string>; tags: Set<string>} {
  const args = new Set<string>();
  const tags = new Set<string>();
  for (const match of message.matchAll(/\{\s*([A-Za-z0-9_]+)/g)) args.add(match[1]);
  for (const match of message.matchAll(/<([A-Za-z0-9_]+)[\s/>]/g)) tags.add(match[1]);
  return {args, tags};
}

/** Same order as the extractor (`compareReferences` in next-intl), so a later extraction run rewrites nothing. */
function compareReferences(a: Reference, b: Reference): number {
  return a.path.localeCompare(b.path, 'en') || a.line - b.line || a.column - b.column;
}

function relative(projectRoot: string, file: string): string {
  return path.relative(projectRoot, file).split(path.sep).join('/');
}

function positionFromOffset(text: string, offset: number) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - (before.lastIndexOf('\n') + 1);
  return {line, column};
}
