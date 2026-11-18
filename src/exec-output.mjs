// Adapted from OpenAI Codex c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee:
// ExecCommandToolOutput, CapturedStream, output-truncation and utils/string.
// Apache-2.0; upstream paths and hashes: third_party/codex-current/SOURCE.json.
const byteLength = text => Buffer.byteLength(text);
export { byteLength };
const approxTokens = bytes => Math.ceil(bytes / 4);
const byteBudget = policy => policy.unit === 'tokens' ? policy.value * 4 : policy.value;
const omissionMarker = omitted => `... ${omitted} bytes omitted ...`;

function truncateText(text, policy) {
  const bytes = Buffer.from(text), budget = byteBudget(policy);
  if (bytes.length <= budget) return text;
  let left = Math.floor(budget / 2), right = bytes.length - (budget - left);
  while (left > 0 && (bytes[left] & 0xc0) === 0x80) left--;
  while (right < bytes.length && (bytes[right] & 0xc0) === 0x80) right++;
  const removed = policy.unit === 'tokens' ? approxTokens(bytes.length - budget) : [...bytes.subarray(left, right).toString()].length;
  const marker = `…${removed} ${policy.unit === 'tokens' ? 'tokens' : 'chars'} truncated…`;
  return bytes.subarray(0, left).toString() + marker + bytes.subarray(right).toString();
}
export { truncateText };
// Keep both ends of long text within a byte budget; failures usually sit at the end.
export const clip = (text, bytes) => truncateText(text, { unit: 'bytes', value: Math.max(0, bytes) });

// Port of utils/string truncate_middle_chars: keep both ends within a byte
// budget on UTF-8 boundaries and insert a removed-character-count marker
// outside that budget. Used to bound tool rejection text like Codex's
// EXEC_COMMAND_REJECTION_MAX_BYTES.
const utf8SequenceLength = byte => byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
export function truncateMiddle(text, maxBytes) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const leftBudget = Math.floor(maxBytes / 2);
  const rightBudget = maxBytes - leftBudget;
  const tailStartTarget = bytes.length - rightBudget;
  let prefixEnd = 0, suffixStart = bytes.length, removedChars = 0, suffixStarted = false;
  for (let index = 0; index < bytes.length;) {
    const charEnd = index + utf8SequenceLength(bytes[index]);
    if (charEnd <= leftBudget) { prefixEnd = charEnd; index = charEnd; continue; }
    if (index >= tailStartTarget) { if (!suffixStarted) { suffixStart = index; suffixStarted = true; } index = charEnd; continue; }
    removedChars++; index = charEnd;
  }
  if (suffixStart < prefixEnd) suffixStart = prefixEnd;
  return bytes.subarray(0, prefixEnd).toString() + `…${removedChars} chars truncated…` + bytes.subarray(suffixStart).toString();
}

// CapturedStream::render: preserve collection-omission metadata even when the
// model's own head/tail truncation removes the original collection marker.
export function renderCaptured(text, omittedBytes, policy, originalTokens) {
  const truncated = truncateText(text, policy);
  if (!omittedBytes) {
    if (byteLength(text) <= byteBudget(policy)) return text;
    const lines = text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
    return `Warning: truncated output (original token count: ${approxTokens(byteLength(text))})\nTotal output lines: ${lines}\n\n${truncated}`;
  }
  const marker = omissionMarker(omittedBytes);
  const notice = truncated.includes(marker) ? '' : marker + '\n';
  if (byteLength(text) <= byteBudget(policy)) return notice + truncated;
  return `Warning: truncated output (original token count: ${originalTokens ?? approxTokens(byteLength(text))})\n${notice}\n${truncated}`;
}

// Codex's collection buffer keeps a stable prefix and the latest suffix.
export class HeadTailBuffer {
  constructor(limit) { this.limit = limit; this.clear(); }
  clear() { this.head = Buffer.alloc(0); this.tail = Buffer.alloc(0); this.omittedBytes = 0; }
  push(chunk) {
    const headBudget = Math.floor(this.limit / 2);
    const fill = Math.min(headBudget - this.head.length, chunk.length);
    if (fill) this.head = Buffer.concat([this.head, chunk.subarray(0, fill)]);
    const tail = Buffer.concat([this.tail, chunk.subarray(fill)]);
    const excess = Math.max(0, tail.length - (this.limit - headBudget));
    this.omittedBytes += excess;
    this.tail = excess ? Buffer.from(tail.subarray(excess)) : tail;
  }
  get totalBytes() { return this.head.length + this.tail.length + this.omittedBytes; }
  text() {
    if (!this.omittedBytes) return Buffer.concat([this.head, this.tail]).toString();
    return this.head.toString() + '\n' + omissionMarker(this.omittedBytes) + '\n' + this.tail.toString();
  }
}

export function execResult(response, outputBytes, maxOutputTokens, toolName = 'exec_command') {
  if (response.error) throw Error(`${toolName} failed: ${response.error}`);
  // One status line where Codex prints five: nothing here refers back to a chunk id, and the
  // original size matters only for cut output, where the truncation warning already states it.
  const seconds = `${response.wall_time_seconds.toFixed(1)}s`;
  const header = response.running ? `Running (${seconds}), session ID ${response.process_id}`
    : response.exit_code !== null && response.exit_code !== undefined ? `Exit code ${response.exit_code} (${seconds})` : `Ended (${seconds})`;
  // Pi supplies a byte cap instead of Codex's model TruncationPolicy. Preserve
  // the upstream 20% serialization allowance and reserve room for the header.
  const requestedTokens = maxOutputTokens ?? 10000;
  let policy = requestedTokens * 4 < outputBytes
    ? { unit: 'tokens', value: requestedTokens } : { unit: 'bytes', value: outputBytes };
  const budget = Math.max(0, Math.floor(outputBytes * 1.2) - byteLength(header) - 1);
  // Node's pipe executor exposes termination separately; retain actual failure
  // information as output text rather than leaking default flags into context.
  const notices = [];
  if (response.timed_out) notices.push('Command timed out.');
  else if (response.cancelled) notices.push('Command cancelled.');
  else if (response.signal) notices.push(`Process terminated by signal ${response.signal}.`);
  const raw = notices.length ? notices.join('\n') + '\n' + response.output : response.output;
  let output = renderCaptured(raw, response.dropped_bytes, policy, response.original_token_count);
  while (byteLength(output) > budget && byteBudget(policy) > 0) {
    const excess = byteLength(output) - budget;
    policy = { ...policy, value: Math.max(0, policy.value - (policy.unit === 'tokens' ? approxTokens(excess) : excess)) };
    output = renderCaptured(raw, response.dropped_bytes, policy, response.original_token_count);
  }
  return {
    content: [{ type: 'text', text: output ? `${header}\n${output}` : header }],
    details: { ...response, execution: true, output },
  };
}
