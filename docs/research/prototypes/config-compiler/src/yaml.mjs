/**
 * Minimal YAML subset loader — zero dependencies.
 *
 * Supported on purpose, and nothing more:
 *   - comments (# to end of line, outside quotes)
 *   - nested mappings by indentation
 *   - block sequences (- item) and sequences of mappings (- key: value)
 *   - inline flow sequences ([a, b, c])
 *   - double-quoted strings, bare scalars, integers, floats, booleans, null
 *
 * Deliberately unsupported: anchors, aliases, multi-line scalars, flow
 * mappings, multiple documents. The prototype owns its fixtures, so the
 * subset is sufficient and a parse failure is a real signal rather than a
 * gap in the loader.
 */

class YamlError extends Error {
  constructor(message, line) {
    super(`${message} (line ${line + 1})`);
    this.name = 'YamlError';
    this.line = line + 1;
  }
}

function stripComment(raw) {
  let out = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"' && raw[i - 1] !== '\\') quoted = !quoted;
    if (ch === '#' && !quoted && (i === 0 || /\s/.test(raw[i - 1]))) break;
    out += ch;
  }
  return out;
}

function scalar(text) {
  const t = text.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return t.slice(1, -1).replace(/\\"/g, '"');
  if (/^'[^']*'$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return Number.parseFloat(t);
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlow(inner).map(scalar);
  }
  return t;
}

/** Split a flow sequence body on commas that are not inside quotes or brackets. */
function splitFlow(body) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '"' && body[i - 1] !== '\\') quoted = !quoted;
    if (!quoted && (ch === '[' || ch === '{')) depth += 1;
    if (!quoted && (ch === ']' || ch === '}')) depth -= 1;
    if (ch === ',' && depth === 0 && !quoted) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

function readLines(text) {
  return text.split('\n').map((raw, index) => {
    const withoutComment = stripComment(raw);
    const content = withoutComment.trimEnd();
    return {
      index,
      indent: content.length - content.trimStart().length,
      text: content.trim(),
      blank: content.trim() === '',
    };
  });
}

/** Split "key: rest" respecting quotes. Returns null when there is no key. */
function splitKey(text) {
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== '\\') quoted = !quoted;
    if (ch === ':' && !quoted && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      return { key: text.slice(0, i).trim(), rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

function parseBlock(lines, start, indent) {
  let i = start;
  while (i < lines.length && lines[i].blank) i += 1;
  if (i >= lines.length || lines[i].indent < indent) return [null, i];

  if (lines[i].text.startsWith('- ') || lines[i].text === '-') {
    return parseSequence(lines, i, lines[i].indent);
  }
  return parseMapping(lines, i, lines[i].indent);
}

function parseSequence(lines, start, indent) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    if (lines[i].blank) { i += 1; continue; }
    if (lines[i].indent !== indent) break;
    if (!lines[i].text.startsWith('- ') && lines[i].text !== '-') break;

    const body = lines[i].text === '-' ? '' : lines[i].text.slice(2).trim();
    const kv = body === '' ? null : splitKey(body);

    if (kv) {
      // Sequence of mappings: first pair sits on the dash line, the rest are
      // indented to align with it.
      const item = {};
      const childIndent = indent + 2;
      if (kv.rest === '') {
        const [nested, next] = parseBlock(lines, i + 1, childIndent + 2);
        item[kv.key] = nested;
        i = next;
      } else {
        item[kv.key] = scalar(kv.rest);
        i += 1;
      }
      while (i < lines.length) {
        if (lines[i].blank) { i += 1; continue; }
        if (lines[i].indent !== childIndent) break;
        if (lines[i].text.startsWith('- ')) break;
        const pair = splitKey(lines[i].text);
        if (!pair) throw new YamlError(`expected "key: value"`, lines[i].index);
        if (pair.rest === '') {
          const [nested, next] = parseBlock(lines, i + 1, childIndent + 1);
          item[pair.key] = nested;
          i = next;
        } else {
          item[pair.key] = scalar(pair.rest);
          i += 1;
        }
      }
      items.push(item);
      continue;
    }

    if (body === '') {
      const [nested, next] = parseBlock(lines, i + 1, indent + 1);
      items.push(nested);
      i = next;
      continue;
    }

    items.push(scalar(body));
    i += 1;
  }
  return [items, i];
}

function parseMapping(lines, start, indent) {
  const map = {};
  let i = start;
  while (i < lines.length) {
    if (lines[i].blank) { i += 1; continue; }
    if (lines[i].indent < indent) break;
    if (lines[i].indent > indent) throw new YamlError('unexpected indentation', lines[i].index);
    if (lines[i].text.startsWith('- ')) break;

    const pair = splitKey(lines[i].text);
    if (!pair) throw new YamlError(`expected "key: value"`, lines[i].index);

    if (pair.rest === '') {
      const [nested, next] = parseBlock(lines, i + 1, indent + 1);
      map[pair.key] = nested;
      i = next;
    } else {
      map[pair.key] = scalar(pair.rest);
      i += 1;
    }
  }
  return [map, i];
}

export function loadYaml(text) {
  const lines = readLines(text);
  const [value] = parseBlock(lines, 0, 0);
  return value === null ? {} : value;
}

export { YamlError };
