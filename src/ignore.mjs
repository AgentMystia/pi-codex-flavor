// A small .gitignore matcher for verification scopes. It keeps build output and caches out of
// code fingerprints, so a check that writes its own artifacts is not stale the moment it ends.
// A pattern this does not understand only leaves a file in the fingerprint.
const literal = char => char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
export function parseIgnore(text) {
  const rules = [];
  for (let line of String(text).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    line = line.replace(/(?<!\\)\s+$/, '');
    const negate = line.startsWith('!'); if (negate) line = line.slice(1);
    const directory = line.endsWith('/'); if (directory) line = line.slice(0, -1);
    if (!line) continue;
    // A slash anywhere but the end ties the pattern to the directory of its .gitignore.
    const anchored = line.includes('/'); if (line.startsWith('/')) line = line.slice(1);
    let source = '';
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '\\' && i + 1 < line.length) source += literal(line[++i]);
      else if (char === '*' && line[i + 1] === '*') {
        if (line[i + 2] === '/') { source += '(?:.*/)?'; i += 2; } else { source += '.*'; i++; }
      } else if (char === '*') source += '[^/]*';
      else if (char === '?') source += '[^/]';
      else if (char === '[' && line.indexOf(']', i + 2) > 0) {
        const end = line.indexOf(']', i + 2);
        source += '[' + line.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = end;
      } else source += literal(char);
    }
    try { rules.push({ regex: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${source}$`), negate, directory }); } catch { /* unsupported pattern */ }
  }
  return rules;
}
// `layers` run from the outermost .gitignore to the innermost; as in Git, the last match wins.
export function ignored(layers, target, isDirectory, relative) {
  let result = false;
  for (const layer of layers) {
    const name = relative(layer.base, target);
    if (!name || name.startsWith('..')) continue;
    for (const rule of layer.rules) if ((!rule.directory || isDirectory) && rule.regex.test(name)) result = !rule.negate;
  }
  return result;
}
