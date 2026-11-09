import ts from 'typescript';

export type Range = {start: number; end: number};
export type HookKind = 'use' | 'get';

const HOOK_BY_IMPORT: Record<string, HookKind> = {
  useTranslations: 'use',
  getTranslations: 'get'
};
const EXTRACTED_BY_HOOK: Record<HookKind, string> = {
  use: 'useExtracted',
  get: 'getExtracted'
};
const MODULE_BY_HOOK: Record<HookKind, string> = {
  use: 'next-intl',
  get: 'next-intl/server'
};

export type CallSite = {
  method: 'call' | 'rich' | 'markup' | 'has' | 'raw';
  /** First argument of the call, replaced by the inline message. */
  argRange?: Range;
  key?: string;
  /** Property names of a literal `values` argument; undefined when absent or not statically known. */
  valueKeys?: Array<string>;
  /** 1-based line and 0-based column of the call, as the SWC extractor reports them. */
  line: number;
  column: number;
};

export type Problem = {reason: string; line: number; column: number};

export type Binding = {
  name: string;
  hook: HookKind;
  /** The `useTranslations(...)` call expression. */
  hookCallRange: Range;
  namespace?: string;
  /** Source text of object-form properties other than `namespace`, e.g. `locale`. */
  otherHookProps?: Array<string>;
  calls: Array<CallSite>;
  problems: Array<Problem>;
};

export type ImportSpecifier = {
  imported: string;
  local: string;
  /** Range of the imported name token (`useTranslations` in `useTranslations as t`). */
  importedRange: Range;
  /** Range of the whole specifier (`useTranslations as t`). */
  elementRange: Range;
  /** References of the imported binding other than hook calls, e.g. `{useTranslations}` in an object. */
  otherUses: number;
};

export type ImportInfo = {
  module: string;
  specifiers: Array<ImportSpecifier>;
  /** Position right after the last named import specifier. */
  appendPosition: number;
};

export type ScannedFile = {
  file: string;
  text: string;
  imports: Array<ImportInfo>;
  bindings: Array<Binding>;
  /** Identifiers named like the old hooks, regardless of where they come from (comments excluded). */
  hookIdentifiers: number;
};

export {EXTRACTED_BY_HOOK, MODULE_BY_HOOK};

function staticString(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function rangeOf(node: ts.Node, sourceFile: ts.SourceFile): Range {
  return {start: node.getStart(sourceFile), end: node.getEnd()};
}

function positionOf(node: ts.Node, sourceFile: ts.SourceFile) {
  const start = node.getStart(sourceFile);
  const {line} = sourceFile.getLineAndCharacterOfPosition(start);
  // The SWC extractor counts columns in code points, TypeScript in UTF-16 units.
  const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
  const column = [...sourceFile.text.slice(lineStart, start)].length;
  return {line: line + 1, column};
}

/**
 * Finds the variable the hook result is bound to:
 * `const t = useTranslations()`, `const t = await getTranslations()` or
 * `const [a, b] = await Promise.all([getTranslations('a'), getTranslations('b')])`.
 */
function findBindingName(call: ts.CallExpression): ts.Identifier | undefined {
  let node: ts.Node = call;
  if (ts.isAwaitExpression(node.parent)) node = node.parent;

  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name;
  }

  if (ts.isArrayLiteralExpression(node.parent)) {
    const index = node.parent.elements.indexOf(node as ts.Expression);
    let declaration: ts.Node = node.parent.parent;
    if (!ts.isCallExpression(declaration)) return undefined;
    declaration = declaration.parent;
    if (ts.isAwaitExpression(declaration)) declaration = declaration.parent;
    if (
      ts.isVariableDeclaration(declaration) &&
      ts.isArrayBindingPattern(declaration.name)
    ) {
      const element = declaration.name.elements[index];
      if (element && ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
        return element.name;
      }
    }
  }
  return undefined;
}

function staticPropertyNames(node: ts.Expression | undefined): Array<string> | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  const names: Array<string> = [];
  for (const property of node.properties) {
    const name = property.name;
    if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name))) return undefined;
    names.push(name.text);
  }
  return names;
}

/** True for an identifier inside the trailing array argument of a `useXxx(...)` call. */
function isHookDependency(reference: ts.Identifier): boolean {
  const array = reference.parent;
  if (!ts.isArrayLiteralExpression(array) || !ts.isCallExpression(array.parent)) return false;
  const call = array.parent;
  if (call.arguments[call.arguments.length - 1] !== array) return false;
  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : '';
  return /^use[A-Z]/.test(name);
}

export function scanFiles(files: Array<string>): Array<ScannedFile> {
  const program = ts.createProgram(files, {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    noResolve: true,
    noLib: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext
  });
  const checker = program.getTypeChecker();
  const result: Array<ScannedFile> = [];

  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) continue;
    result.push(scanSourceFile(sourceFile, checker));
  }
  return result;
}

function scanSourceFile(sourceFile: ts.SourceFile, checker: ts.TypeChecker): ScannedFile {
  const imports: Array<ImportInfo> = [];
  const hookByImportSymbol = new Map<ts.Symbol, HookKind>();
  const hookSpecifiers: Array<{specifier: ImportSpecifier; symbol: ts.Symbol; nameNode: ts.Identifier}> = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleName = staticString(statement.moduleSpecifier);
    if (moduleName !== 'next-intl' && moduleName !== 'next-intl/server') continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;

    const info: ImportInfo = {
      module: moduleName,
      specifiers: [],
      appendPosition: named.elements[named.elements.length - 1]?.getEnd() ?? named.getEnd() - 1
    };
    for (const element of named.elements) {
      const importedNode = element.propertyName ?? element.name;
      const imported = importedNode.text;
      const specifier: ImportSpecifier = {
        imported,
        local: element.name.text,
        importedRange: rangeOf(importedNode, sourceFile),
        elementRange: rangeOf(element, sourceFile),
        otherUses: 0
      };
      info.specifiers.push(specifier);
      const hook = HOOK_BY_IMPORT[imported];
      if (hook && MODULE_BY_HOOK[hook] === moduleName) {
        const symbol = checker.getSymbolAtLocation(element.name);
        if (symbol) {
          hookByImportSymbol.set(symbol, hook);
          hookSpecifiers.push({specifier, symbol, nameNode: element.name});
        }
      }
    }
    imports.push(info);
  }

  const bindings: Array<Binding> = [];
  let hookIdentifiers = 0;
  const countHookIdentifiers = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text in HOOK_BY_IMPORT) hookIdentifiers++;
    ts.forEachChild(node, countHookIdentifiers);
  };
  countHookIdentifiers(sourceFile);
  const result: ScannedFile = {file: sourceFile.fileName, text: sourceFile.text, imports, bindings, hookIdentifiers};
  if (hookByImportSymbol.size === 0) return result;

  // One pass collects every identifier by symbol, so references of a binding
  // are a lookup instead of a traversal per binding.
  const identifiersBySymbol = new Map<ts.Symbol, Array<ts.Identifier>>();
  const hookCalls: Array<{call: ts.CallExpression; hook: HookKind}> = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (symbol) {
        const list = identifiersBySymbol.get(symbol) ?? [];
        list.push(node);
        identifiersBySymbol.set(symbol, list);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      const hook = symbol && hookByImportSymbol.get(symbol);
      if (hook) hookCalls.push({call: node, hook});
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const hookCallees = new Set<ts.Node>(hookCalls.map(({call}) => call.expression));
  for (const {specifier, symbol, nameNode} of hookSpecifiers) {
    specifier.otherUses = (identifiersBySymbol.get(symbol) ?? []).filter(
      (identifier) => identifier !== nameNode && !hookCallees.has(identifier)
    ).length;
  }

  for (const {call, hook} of hookCalls) {
    const binding: Binding = {
      name: '',
      hook,
      hookCallRange: rangeOf(call, sourceFile),
      calls: [],
      problems: []
    };
    bindings.push(binding);
    const position = positionOf(call, sourceFile);

    const arg = call.arguments[0];
    if (arg) {
      if (ts.isObjectLiteralExpression(arg)) {
        binding.otherHookProps = [];
        for (const property of arg.properties) {
          const name = property.name && ts.isIdentifier(property.name) ? property.name.text : undefined;
          if (name === 'namespace' && ts.isPropertyAssignment(property)) {
            const namespace = staticString(property.initializer);
            if (namespace === undefined) {
              binding.problems.push({reason: 'dynamic-namespace', ...position});
            }
            binding.namespace = namespace;
          } else {
            binding.otherHookProps.push(property.getText(sourceFile));
          }
        }
      } else {
        const namespace = staticString(arg);
        if (namespace === undefined) {
          binding.problems.push({reason: 'dynamic-namespace', ...position});
        }
        binding.namespace = namespace;
      }
    }

    const nameNode = findBindingName(call);
    if (!nameNode) {
      binding.problems.push({reason: 'hook-result-not-bound-to-variable', ...position});
      continue;
    }
    binding.name = nameNode.text;
    const symbol = checker.getSymbolAtLocation(nameNode);
    const references = (symbol && identifiersBySymbol.get(symbol)) ?? [];

    for (const reference of references) {
      if (reference === nameNode) continue;
      const referencePosition = positionOf(reference, sourceFile);
      let callExpression: ts.CallExpression | undefined;
      let method: CallSite['method'] = 'call';

      if (ts.isCallExpression(reference.parent) && reference.parent.expression === reference) {
        callExpression = reference.parent;
      } else if (
        ts.isPropertyAccessExpression(reference.parent) &&
        reference.parent.expression === reference &&
        ts.isCallExpression(reference.parent.parent) &&
        reference.parent.parent.expression === reference.parent
      ) {
        const property = reference.parent.name.text;
        if (property === 'rich' || property === 'markup' || property === 'has' || property === 'raw') {
          method = property;
          callExpression = reference.parent.parent;
        }
      }

      if (!callExpression) {
        // `useCallback(() => t('x'), [t])`: the dependency list reads `t` but never calls it.
        if (!isHookDependency(reference)) {
          binding.problems.push({reason: 'translator-used-outside-call', ...referencePosition});
        }
        continue;
      }
      if (method === 'has' || method === 'raw') {
        binding.problems.push({reason: `t.${method}-not-supported-by-extraction`, ...referencePosition});
        continue;
      }

      // The extractor does not recognize `t?.()`, so the message would be dropped from the catalogs.
      if (callExpression.questionDotToken || (method !== 'call' && (callExpression.expression as ts.PropertyAccessExpression).questionDotToken)) {
        binding.problems.push({reason: 'optional-call-not-supported-by-extraction', ...referencePosition});
        continue;
      }

      const keyNode = callExpression.arguments[0];
      const key = staticString(keyNode);
      if (key === undefined) {
        binding.problems.push({reason: 'dynamic-key', ...referencePosition});
        continue;
      }
      binding.calls.push({
        method,
        argRange: rangeOf(keyNode, sourceFile),
        key,
        valueKeys: staticPropertyNames(callExpression.arguments[1]),
        ...positionOf(callExpression, sourceFile)
      });
    }
  }

  return result;
}
