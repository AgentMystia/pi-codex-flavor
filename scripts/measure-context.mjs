// Measures the fixed per-request context this package contributes: system prompt and tool schemas.
import { getSystemMessageText } from '@earendil-works/pi-ai';
import { sessionFixture } from '../test/helpers.mjs';
const cleanups = [];
const { session, requests } = await sessionFixture({ after: fn => cleanups.push(fn) }, () => 'done');
try {
  await session.prompt('hello');
  const system = requests[0].messages[0];
  const prompt = getSystemMessageText(system);
  const tokens = text => Math.ceil(Buffer.byteLength(text) / 4);
  const tools = (system.toolsAdded ?? []).map(tool => ({ name: tool.name, tokens: tokens(JSON.stringify(tool)) }));
  const toolTokens = tools.reduce((sum, tool) => sum + tool.tokens, 0);
  console.log(JSON.stringify({ promptTokens: tokens(prompt), toolCount: tools.length, toolTokens, total: tokens(prompt) + toolTokens }));
  if (process.argv.includes('--tools')) for (const tool of tools.sort((a, b) => b.tokens - a.tokens)) console.log(`${String(tool.tokens).padStart(5)} ${tool.name}`);
  if (process.argv.includes('--prompt')) console.log(prompt);
} finally { for (const fn of cleanups.reverse()) await fn(); }
