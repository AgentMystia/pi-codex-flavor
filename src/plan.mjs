// Plan Mode: <proposed_plan> parsing and the post-plan selection prompt.
// Ported from the pinned Codex source (see third_party/codex-current/SOURCE.json):
// utils/stream-parser/src/{proposed_plan,tagged_line_parser}.rs and
// tui/src/chatwidget/plan_implementation.rs at commit c0cc9fc8.

const OPEN_TAG = '<proposed_plan>';
const CLOSE_TAG = '</proposed_plan>';

/// Line-based port of TaggedLineParser + extract_proposed_plan_text. Tags must
/// appear alone on their line (leading/trailing whitespace allowed); an
/// unterminated block is closed at the end of the text; when several blocks
/// exist, the last one wins. Returns null when no block was seen.
export function extractProposedPlan(text) {
  const lines = String(text ?? '').split('\n');
  let active = false;
  let sawBlock = false;
  let plan = '';
  for (const [index, line] of lines.entries()) {
    const hadNewline = index < lines.length - 1;
    const slug = line.trim();
    if (!active && slug === OPEN_TAG) { active = true; sawBlock = true; plan = ''; continue; }
    if (active && slug === CLOSE_TAG) { active = false; continue; }
    if (active) plan += line + (hadNewline ? '\n' : '');
  }
  return sawBlock ? plan : null;
}

// Verbatim prompt copy from tui/src/chatwidget/plan_implementation.rs.
export const PLAN_IMPLEMENTATION_TITLE = 'Implement this plan?';
export const PLAN_IMPLEMENTATION_YES = 'Yes, implement this plan';
export const PLAN_IMPLEMENTATION_CLEAR_CONTEXT = 'Yes, clear context and implement';
export const PLAN_IMPLEMENTATION_NO = 'No, stay in Plan mode';
export const PLAN_IMPLEMENTATION_CODING_MESSAGE = 'Implement the plan.';
export const PLAN_IMPLEMENTATION_DEFAULT_UNAVAILABLE = 'Default mode unavailable';
export const PLAN_IMPLEMENTATION_NO_APPROVED_PLAN = 'No approved plan available';
export const PLAN_IMPLEMENTATION_HINT = 'enter select · esc back';

/// Mirrors selection_view_params: item order, descriptions, and disabled
/// reasons match Codex. The default mode is always available in this suite, so
/// only the missing-plan reason can disable the clear-context option.
export function planSelectionItems({ planMarkdown, usageLabel = null, defaultModeUnavailable = false }) {
  const disabled = reason => reason && { reason };
  return [
    { id: 'implement', name: PLAN_IMPLEMENTATION_YES, description: 'Switch to Default and start coding',
      disabled: disabled(defaultModeUnavailable && PLAN_IMPLEMENTATION_DEFAULT_UNAVAILABLE) },
    { id: 'fresh', name: PLAN_IMPLEMENTATION_CLEAR_CONTEXT,
      description: usageLabel ? `Start a fresh thread (current context: ${usageLabel})` : 'Fresh thread with this plan',
      disabled: disabled((defaultModeUnavailable && PLAN_IMPLEMENTATION_DEFAULT_UNAVAILABLE) || (!planMarkdown || !planMarkdown.trim() ? PLAN_IMPLEMENTATION_NO_APPROVED_PLAN : null)) },
    { id: 'stay', name: PLAN_IMPLEMENTATION_NO, description: 'Continue planning with the model', disabled: null },
  ];
}

/// Mirrors plan_implementation_context_usage_label: "89% used" when a
/// percentage is known, "123K used" from raw tokens otherwise, null when the
/// context looks fresh or unknown. Pi's getContextUsage().percent is the USED
/// share (float); Codex rounds the remaining percentage to an integer and
/// subtracts it from 100, so the displayed used share follows that math.
export function planUsageLabel(usage) {
  if (!usage) return null;
  if (usage.percent != null) {
    const remaining = Math.round(100 - usage.percent);
    const used = 100 - Math.min(100, Math.max(0, remaining));
    return used > 0 ? `${used}% used` : null;
  }
  if (usage.tokens != null && usage.tokens > 0) return `${formatTokensCompact(usage.tokens)} used`;
  return null;
}

/// Port of tui format_tokens_compact: plain below 1000, unit promotion at the
/// 999.5% thresholds (999,500 -> "1M"), 2/1/0 decimals by scaled magnitude
/// with trailing zeros trimmed (1,234,567 -> "1.23M", 2,500,000 -> "2.5M").
export function formatTokensCompact(value) {
  const tokens = Math.max(0, Math.round(value));
  if (tokens === 0) return '0';
  if (tokens < 1000) return String(tokens);
  let scaled, suffix;
  if (tokens >= 999_500_000_000) { scaled = tokens / 1e12; suffix = 'T'; }
  else if (tokens >= 999_500_000) { scaled = tokens / 1e9; suffix = 'B'; }
  else if (tokens >= 999_500) { scaled = tokens / 1e6; suffix = 'M'; }
  else { scaled = tokens / 1e3; suffix = 'K'; }
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  return `${Number(scaled.toFixed(decimals))}${suffix}`;
}
