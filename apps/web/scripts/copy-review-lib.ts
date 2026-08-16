import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';

interface AstNode {
  type: string;
  [key: string]: unknown;
}

const USER_COPY_CALLS = new Set([
  'alert',
  'confirm',
  'errorResponse',
  'prompt',
  'setError',
  'setNotice',
  'setSuccess',
]);
const USER_COPY_PROPERTIES = new Set([
  'aria-label',
  'currentStep',
  'description',
  'error',
  'label',
  'lastError',
  'message',
  'placeholder',
  'safeErrorMessage',
  'title',
]);

function normalizeCopy(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, ' ').trim();
  // Punctuation-only JSX nodes are layout, not independently reviewable copy.
  return /[\p{L}\p{N}]/u.test(normalized) ? normalized : undefined;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { type?: unknown }).type === 'string';
}

function staticText(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (value.type === 'StringLiteral' && typeof value.value === 'string') {
    return normalizeCopy(value.value);
  }
  if (value.type === 'TemplateLiteral' && Array.isArray(value.quasis)) {
    return normalizeCopy(
      value.quasis.map((quasi, index) => {
        if (!isNode(quasi) || typeof quasi.value !== 'object' || quasi.value === null) return '';
        const quasiValue = quasi.value as { cooked?: unknown; raw?: unknown };
        const text = typeof quasiValue.cooked === 'string'
          ? quasiValue.cooked
          : typeof quasiValue.raw === 'string'
            ? quasiValue.raw
            : '';
        return `${index === 0 ? '' : '${…}'}${text}`;
      }).join(''),
    );
  }
  return undefined;
}

function propertyName(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (
    (value.type === 'Identifier' || value.type === 'JSXIdentifier')
    && typeof value.name === 'string'
  ) return value.name;
  if (value.type === 'StringLiteral' && typeof value.value === 'string') return value.value;
  return undefined;
}

function callName(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (value.type === 'Identifier' && typeof value.name === 'string') return value.name;
  if (value.type === 'MemberExpression') return propertyName(value.property);
  return undefined;
}

function isRenderedJsxExpression(
  node: AstNode,
  ancestors: readonly AstNode[],
  legacyAllJsxAttributes = false,
): boolean {
  let child: AstNode = node;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const current = ancestors[index];
    if (!legacyAllJsxAttributes && current.type === 'JSXAttribute') return false;
    if (current.type === 'ConditionalExpression' && current.test === child) return false;
    if (current.type === 'BinaryExpression') {
      const operator = current.operator;
      if (
        operator === '=='
        || operator === '==='
        || operator === '!='
        || operator === '!=='
        || operator === 'in'
        || operator === 'instanceof'
      ) return false;
    }
    if (
      current.type === 'LogicalExpression'
      && current.left === child
      && (current.operator === '&&' || current.operator === '||' || current.operator === '??')
    ) return false;
    if (current.type === 'JSXExpressionContainer') {
      // Attribute expressions mostly contain CSS/class tokens. Child
      // expressions are rendered text and therefore require copy review.
      return ancestors[index - 1]?.type !== 'JSXAttribute';
    }
    if (current.type.endsWith('Statement') || current.type === 'Program') return false;
    child = current;
  }
  return false;
}

/**
 * Extract source literals that reach the browser or an API error response.
 * Existing literals are grandfathered by a revision-pinned baseline; any new
 * text must instead have a hash and provenance in reviewed-copy.json.
 */
export function extractUserVisibleCopy(
  source: string,
  fileName: string,
  options: { legacyAllJsxAttributes?: boolean } = {},
): string[] {
  const sourceFile = parse(source, {
    errorRecovery: false,
    plugins: fileName.endsWith('x') ? ['typescript', 'jsx'] : ['typescript'],
    sourceFilename: fileName,
    sourceType: 'unambiguous',
  });
  const values: string[] = [];
  const add = (value: string | undefined): void => {
    if (value) values.push(value);
  };

  const visit = (node: AstNode, ancestors: readonly AstNode[]): void => {
    if (node.type === 'JSXText' && typeof node.value === 'string') {
      add(normalizeCopy(node.value));
    } else if (node.type === 'JSXAttribute' && node.value) {
      const name = propertyName(node.name);
      if (options.legacyAllJsxAttributes) {
        if (isNode(node.value) && node.value.type === 'StringLiteral') {
          add(staticText(node.value));
        }
      } else if (name !== undefined && USER_COPY_PROPERTIES.has(name)) {
        if (isNode(node.value) && node.value.type === 'StringLiteral') {
          add(staticText(node.value));
        } else if (isNode(node.value) && node.value.type === 'JSXExpressionContainer') {
          add(staticText(node.value.expression));
        }
      }
    } else if (
      (node.type === 'StringLiteral' || node.type === 'TemplateLiteral')
      && isRenderedJsxExpression(node, ancestors, options.legacyAllJsxAttributes)
    ) {
      add(staticText(node));
    } else if (node.type === 'ObjectProperty') {
      const name = propertyName(node.key);
      if (name && USER_COPY_PROPERTIES.has(name)) add(staticText(node.value));
    } else if (
      node.type === 'VariableDeclarator'
      && propertyName(node.id)?.toLowerCase().endsWith('error') === true
      && node.init
    ) {
      // Routes and persistence adapters often assign a user-facing failure
      // once, then persist and return it through several branches. Treat any
      // exact `*Error` binding as copy so renaming it (for example to
      // `earlyError`) cannot bypass review.
      add(staticText(node.init));
    } else if (
      node.type === 'AssignmentExpression'
      && node.operator === '='
      && isNode(node.left)
      && node.left.type === 'MemberExpression'
      && USER_COPY_PROPERTIES.has(propertyName(node.left.property) ?? '')
    ) {
      add(staticText(node.right));
    } else if (node.type === 'CallExpression') {
      const name = callName(node.callee);
      if (name && USER_COPY_CALLS.has(name) && Array.isArray(node.arguments)) {
        add(staticText(node.arguments[0]));
      }
    }

    const nextAncestors = [...ancestors, node];
    for (const value of Object.values(node)) {
      if (isNode(value)) {
        visit(value, nextAncestors);
      } else if (Array.isArray(value)) {
        for (const child of value) {
          if (isNode(child)) visit(child, nextAncestors);
        }
      }
    }
  };
  visit(sourceFile, []);
  return values;
}

export function copyHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Deterministic, duplicate-preserving representation used by a pinned baseline. */
export function packCopy(values: Iterable<string>): string {
  const hashes = [...values].map(copyHash).sort();
  return Buffer.concat(hashes.map((hash) => Buffer.from(hash, 'hex'))).toString('base64');
}

export interface CopyCount {
  count: number;
  text: string;
}

export function countCopy(values: Iterable<string>): Map<string, CopyCount> {
  const counts = new Map<string, CopyCount>();
  for (const value of values) {
    const hash = copyHash(value);
    const existing = counts.get(hash);
    counts.set(hash, {
      count: (existing?.count ?? 0) + 1,
      text: value,
    });
  }
  return counts;
}

export interface UnreviewedCopy {
  count: number;
  sha256: string;
  text: string;
}

export function unreviewedCopy(
  values: Iterable<string>,
  baselineCounts: ReadonlyMap<string, number>,
  reviewedCounts: ReadonlyMap<string, number>,
): UnreviewedCopy[] {
  return [...countCopy(values).entries()]
    .flatMap(([sha256, current]) => {
      const allowed = (baselineCounts.get(sha256) ?? 0) + (reviewedCounts.get(sha256) ?? 0);
      return current.count > allowed
        ? [{
            count: current.count - allowed,
            sha256,
            text: current.text,
          }]
        : [];
    })
    .sort((left, right) => left.text.localeCompare(right.text));
}

function decodeDartLiteral(quoted: string): string {
  const quote = quoted[0];
  const body = quoted.slice(1, -1);
  return body.replace(/\\(.)/gs, (_match, escaped: string) => {
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 't') return '\t';
    if (escaped === quote || escaped === '\\' || escaped === '$') return escaped;
    return `\\${escaped}`;
  });
}

function decodeKotlinLiteral(quoted: string): string {
  const body = quoted.slice(1, -1);
  return body.replace(/\\(.)/gs, (_match, escaped: string) => {
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 't') return '\t';
    if (escaped === '"' || escaped === '\\' || escaped === '$') return escaped;
    return `\\${escaped}`;
  });
}

/** Extract every static string constant from the Android copy catalogue. */
export function extractDartCopyConstants(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  const assignment =
    /static\s+const\s+([A-Za-z_]\w*)\s*=\s*((?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*)+);/gs;
  for (const match of source.matchAll(assignment)) {
    const literals = [...match[2].matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gs)];
    values[match[1]] = literals.map((literal) => decodeDartLiteral(literal[0])).join('');
  }
  return values;
}

/** Extract every native Android string constant from NotificationCopy.kt. */
export function extractKotlinCopyConstants(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  const assignment = /const\s+val\s+([A-Za-z_]\w*)\s*=\s*("(?:\\.|[^"\\])*")/gs;
  for (const match of source.matchAll(assignment)) {
    values[match[1]] = decodeKotlinLiteral(match[2]);
  }
  return values;
}

/** User-visible Flutter literals must live in companion_copy.dart, not at call sites. */
export function directFlutterCopyLiterals(source: string): string[] {
  const candidates: string[] = [];
  const patterns = [
    /\b(?:Text|_Muted)\(\s*(?:const\s+)?("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gs,
    /\b(?:labelText|hintText|tooltip|semanticLabel)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gs,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      // Interpolated values are runtime data, not copy. Keep any literal words
      // around them gated, but ignore expressions whose only static content is
      // punctuation/layout (for example '${account.name} · ${date}').
      const staticContent = decodeDartLiteral(match[1])
        .replace(/\$\{[^{}]*\}/g, ' ')
        .replace(/\$[A-Za-z_]\w*/g, ' ');
      const value = normalizeCopy(staticContent);
      if (value) candidates.push(value);
    }
  }
  return candidates;
}
