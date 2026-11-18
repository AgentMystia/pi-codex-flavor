export function parsePatch(patch) {
  const lines = patch.replace(/\r\n/g, '\n').trim().split('\n');
  if (lines.shift()?.trim() !== '*** Begin Patch' || lines.pop()?.trim() !== '*** End Patch') throw Error('Patch must have Begin Patch and End Patch markers');
  const operations = []; let index = 0;
  while (index < lines.length) {
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[index++]);
    if (!match) throw Error(`Invalid file header at line ${index + 1}`);
    const operation = { kind: match[1].toLowerCase(), path: match[2].trim(), chunks: [] };
    if (operation.kind === 'add') {
      const content = [];
      while (index < lines.length && !lines[index].startsWith('*** ')) {
        if (!lines[index].startsWith('+')) throw Error('Added file lines must begin with +');
        content.push(lines[index++].slice(1));
      }
      operation.content = content.join('\n') + (content.length ? '\n' : '');
    } else if (operation.kind === 'update') {
      if (lines[index]?.startsWith('*** Move to: ')) operation.move = lines[index++].slice(13).trim();
      while (index < lines.length && (!lines[index].startsWith('*** ') || lines[index] === '*** End of File')) {
        // As in Codex, only the first hunk of a file may leave out its @@ line.
        let anchor = '';
        if (lines[index] === '@@' || lines[index].startsWith('@@ ')) anchor = lines[index++].slice(3);
        else if (operation.chunks.length) throw Error('Update chunks must begin with @@');
        const chunk = { anchor, old: [], replacement: [], context: [], eof: false };
        while (index < lines.length && !lines[index].startsWith('@@') && !lines[index].startsWith('*** ')) {
          // An empty line stands for an empty context line whose leading space was dropped.
          const line = lines[index++]; const prefix = line === '' ? ' ' : line[0];
          if (![' ', '-', '+'].includes(prefix)) throw Error(`Invalid patch line: ${line}`);
          if (prefix === ' ') chunk.context.push([chunk.old.length, chunk.replacement.length]);
          if (prefix !== '+') chunk.old.push(line.slice(1));
          if (prefix !== '-') chunk.replacement.push(line.slice(1));
        }
        if (lines[index] === '*** End of File') { chunk.eof = true; index++; }
        if (!chunk.old.length && !chunk.replacement.length) throw Error('Empty update chunk');
        operation.chunks.push(chunk);
      }
      if (!operation.chunks.length && !operation.move) throw Error('Empty update operation');
    }
    operations.push(operation);
  }
  if (!operations.length) throw Error('Empty patch');
  return operations;
}
// Codex's seek_sequence order: exact text first, then ignoring trailing whitespace, then
// ignoring surrounding whitespace. A looser level is tried only when a stricter one finds nothing.
const LEVELS = [line => line, line => line.trimEnd(), line => line.trim()];
function locate(lines, old, cursor, eof) {
  for (const normalize of LEVELS) {
    const wanted = old.map(normalize), matches = [];
    for (let i = cursor; i <= lines.length - wanted.length; i++) {
      if (eof && i + wanted.length !== lines.length) continue;
      if (wanted.every((line, offset) => normalize(lines[i + offset]) === line)) matches.push(i);
    }
    if (matches.length) return matches;
  }
  return [];
}
export function updateContent(before, chunks) {
  const crlf = before.includes('\r\n');
  const lines = before.replace(/\r\n/g, '\n').split('\n');
  const ended = lines.at(-1) === ''; if (ended) lines.pop();
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor) {
      let found = -1;
      for (const normalize of LEVELS) {
        const wanted = normalize(chunk.anchor);
        found = lines.findIndex((line, position) => position >= cursor && normalize(line) === wanted);
        if (found >= 0) break;
      }
      if (found < 0) throw Error(`Patch context not found: ${chunk.anchor}`); cursor = found + 1;
    }
    let at = chunk.eof ? lines.length : cursor;
    let { old, replacement } = chunk;
    if (old.length) {
      let matches = locate(lines, old, cursor, chunk.eof);
      // A blank line written after the hunk parses as one more context line; retry without it.
      if (!matches.length && old.length > 1 && old.at(-1) === '' && replacement.at(-1) === '') {
        old = old.slice(0, -1); replacement = replacement.slice(0, -1);
        matches = locate(lines, old, cursor, chunk.eof);
      }
      if (!matches.length) throw Error(`Patch context does not match current contents near: ${JSON.stringify(chunk.old[0])}`);
      // An @@ anchor says where to look, so the first match after it is the intended one.
      if (matches.length > 1 && !chunk.anchor) throw Error('Ambiguous patch context; include more lines or an @@ anchor');
      at = matches[0];
    }
    // Context matched loosely is not a requested change: unchanged lines keep the file's own text.
    replacement = [...replacement];
    for (const [from, to] of chunk.context ?? []) if (from < old.length && to < replacement.length) replacement[to] = lines[at + from];
    lines.splice(at, old.length, ...replacement); cursor = at + replacement.length;
  }
  return lines.join(crlf ? '\r\n' : '\n') + (ended ? (crlf ? '\r\n' : '\n') : '');
}
