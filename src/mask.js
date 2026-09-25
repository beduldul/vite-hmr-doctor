/**
 * Lexical masking shared by the source scanners in `checks.js` and `resolve.js`.
 *
 * Both files need to reason about config *text* without being fooled by text
 * that only looks like config. Keeping one implementation here means the two
 * scanners cannot drift apart.
 */

/**
 * Blank out comments and string/template contents, preserving length and
 * newlines so offsets stay valid. This keeps regex searches from matching text
 * that only appears inside a comment or a string.
 *
 * @param {string} source
 * @returns {string} Same length as `source`.
 */
export function maskCommentsAndStrings(source) {
  let masked = '';

  for (let index = 0; index < source.length; index += 1) {
    const commentEnd = commentEndAt(source, index);
    if (commentEnd !== -1) {
      masked += source.slice(index, commentEnd + 1).replace(/[^\n]/g, ' ');
      index = commentEnd;
      continue;
    }

    const delimiter = stringDelimiterAt(source, index);
    if (delimiter !== null) {
      const end = skipString(source, index, delimiter);
      masked += source.slice(index, end).replace(/[^\n]/g, ' ');
      index = end - 1;
      continue;
    }

    masked += source[index];
  }

  return masked;
}

/**
 * Blank out comments and quoted strings, keeping template-literal `${...}`
 * interpolation *live*.
 *
 * `maskCommentsAndStrings` blanks an entire template literal, including its
 * interpolations. That is right when the goal is "is this text real config?",
 * but wrong when the goal is "what does this expression evaluate to" — a config
 * written as `` `${port}` `` must still be readable. This variant masks only the
 * literal chunks and re-enters masking for the interpolated expressions.
 *
 * @param {string} source
 * @returns {string} Same length as `source`.
 */
export function maskOutsideTemplateExpressions(source) {
  let masked = '';

  for (let index = 0; index < source.length; index += 1) {
    const commentEnd = commentEndAt(source, index);
    if (commentEnd !== -1) {
      masked += source.slice(index, commentEnd + 1).replace(/[^\n]/g, ' ');
      index = commentEnd;
      continue;
    }

    const delimiter = stringDelimiterAt(source, index);
    if (delimiter !== null) {
      const end = skipString(source, index, delimiter);
      masked += maskTemplate(source, index, end, delimiter);
      index = end - 1;
      continue;
    }

    masked += source[index];
  }

  return masked;
}

/** Mask a string/template that spans `[start, end)`. */
function maskTemplate(source, start, end, delimiter) {
  if (delimiter !== '`') {
    return source.slice(start, end).replace(/[^\n]/g, ' ');
  }

  let out = ' ';
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    if (source[cursor] === '\\') {
      out += ' ';
      cursor += 1;
      if (cursor < end) out += source[cursor] === '\n' ? '\n' : ' ';
      continue;
    }

    if (source[cursor] === '$' && source[cursor + 1] === '{') {
      const close = findInterpolationEnd(source, cursor + 2, end);
      out += '${';
      out += maskOutsideTemplateExpressions(source.slice(cursor + 2, close));
      out += source[close] === '}' ? '}' : '';
      cursor = close;
      continue;
    }

    out += source[cursor] === '\n' ? '\n' : ' ';
  }

  // `out` starts with the opening delimiter's slot; pad any shortfall so the
  // result keeps the original length exactly.
  return out.length === end - start ? out : out.padEnd(end - start, ' ').slice(0, end - start);
}

/** Index of the `}` closing an interpolation that opened at `body`. */
function findInterpolationEnd(source, body, limit) {
  let depth = 1;

  for (let cursor = body; cursor < limit; cursor += 1) {
    const commentEnd = commentEndAt(source, cursor);
    if (commentEnd !== -1) {
      cursor = commentEnd;
      continue;
    }

    const delimiter = stringDelimiterAt(source, cursor);
    if (delimiter !== null) {
      cursor = skipString(source, cursor, delimiter) - 1;
      continue;
    }

    if (source[cursor] === '{') depth += 1;
    else if (source[cursor] === '}') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }

  return limit;
}

/** True when `text` opens a string or template at `index`. */
export function stringDelimiterAt(text, index) {
  const char = text[index];
  if (char === '"' || char === "'" || char === '`') return char;
  if (char === '/' && text[index + 1] !== '/') return '/';
  return null;
}

/** Index of the end of a comment opening at `index`, or -1. */
export function commentEndAt(text, index) {
  if (text[index] !== '/' || text[index + 1] === undefined) return -1;
  if (text[index + 1] === '/') {
    const newline = text.indexOf('\n', index + 2);
    return newline === -1 ? text.length : newline;
  }
  if (text[index + 1] === '*') {
    const close = text.indexOf('*/', index + 2);
    return close === -1 ? text.length : close + 1;
  }
  return -1;
}

/**
 * Find a delimiter char and the index just after its closing occurrence,
 * skipping escaped characters.
 *
 * @param {string} text
 * @param {number} index Index of the opening delimiter.
 * @param {string} delimiter
 * @returns {number} Index just past the closing delimiter, or `text.length`.
 */
export function skipString(text, index, delimiter) {
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === '\\') {
      cursor += 1;
    } else if (text[cursor] === delimiter) {
      return cursor + 1;
    }
  }
  return text.length;
}
