import { createHash, randomBytes } from 'node:crypto';
// Ids are echoed in tool results and typed back by the model, so they stay short:
// 48 random bits are ample for uniqueness within one session.
export const id = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
export const hash = (data) => createHash('sha256').update(data).digest('hex');
export const clone = (value) => structuredClone(value);
export const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
export function abortError() { return new Error('Operation cancelled', { cause: 'cancelled' }); }
export function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
export function bounded(text, limit = 24000) {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString('utf8')}\n[truncated: ${bytes.length - end} bytes omitted]`;
}
// Codex serializes structured tool output compactly (serde_json::to_string);
// pretty-printed JSON would spend tokens on indentation in every result.
export function result(value) { return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], details: typeof value === 'object' ? value : {} }; }
// The model gets `shown`; the full value stays in details for the UI and the session record.
export function compact(value, shown) { return { content: [{ type: 'text', text: typeof shown === 'string' ? shown : JSON.stringify(shown) }], details: value && typeof value === 'object' ? value : {} }; }
// Pi delivers a message typed during a tool call only after the call returns, so long waits
// watch for one and end early instead of holding the user's steering back.
export function whenInput(check, signal, intervalMs = 250) {
  let timer;
  const promise = new Promise(resolve => {
    if (!check) return;
    const poll = () => { if (signal?.aborted) return; if (check()) resolve(true); else timer = setTimeout(poll, intervalMs); };
    timer = setTimeout(poll, intervalMs);
  });
  return { promise, stop: () => clearTimeout(timer) };
}
export class SerialQueue {
  tail = Promise.resolve();
  run(fn) { const next = this.tail.then(fn); this.tail = next.catch(() => {}); return next; }
}
export function cleanTerminal(text) { return String(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''); }
