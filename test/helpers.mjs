import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SessionManager, ModelRuntime, DefaultResourceLoader, SettingsManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import codexFlavor from '../index.mjs';
import { Runtime } from '../src/runtime.mjs';
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export const model = { id: 'mock-code', name: 'Mock', provider: 'mock', api: 'anthropic-messages', baseUrl: 'http://localhost/mock', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 };
export function mockStream(handler = () => 'done', requests = []) {
  return (selectedModel, context, options = {}) => {
    const stream = createAssistantMessageEventStream(); requests.push(structuredClone(context));
    (async () => {
      try {
        const output = await handler(context, options);
        const message = { role: 'assistant', api: selectedModel.api, provider: selectedModel.provider, model: selectedModel.id, usage: structuredClone(usage), timestamp: Date.now(),
          content: typeof output === 'string' ? [{ type: 'text', text: output }] : output.content ?? output,
          stopReason: (output.content ?? output)?.some?.(c => c.type === 'toolCall') ? 'toolUse' : 'stop', ...(output.extra ?? {}) };
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
      } catch (error) {
        const message = { role: 'assistant', api: selectedModel.api, provider: selectedModel.provider, model: selectedModel.id, usage: structuredClone(usage), timestamp: Date.now(), content: [], stopReason: 'error', errorMessage: error.message };
        stream.push({ type: 'error', reason: 'error', error: message }); stream.end();
      }
    })(); return stream;
  };
}
export async function fixture(t, { config = {}, ui, handler, requests = [], agentDir } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-codex-test-')); const sessionDir = await mkdtemp(path.join(tmpdir(), 'pi-codex-sessions-'));
  const isolate = agentDir ?? await mkdtemp(path.join(tmpdir(), 'pi-codex-agentdir-'));
  const persisted = [], events = [];
  const context = { cwd: root, model, thinkingLevel: 'high', modelRegistry: { streamSimple: mockStream(handler, requests), find: (provider, id) => provider === model.provider && id === model.id ? model : undefined },
    sessionManager: SessionManager.create(root, sessionDir), getSystemPrompt: () => 'Custom user prompt and project rules', hasUI: !!ui, mode: ui ? 'rpc' : 'print' };
  const runtime = await Runtime.create({ root, config: { sandbox: 'none', approval: 'on-request', ...config }, agentDir: isolate, persist: (type, data) => persisted.push({ customType: type, data }), getContext: () => context, getUI: () => ui ?? { available: false }, deliver: event => events.push(event) });
  const call = async (name, params = {}, signal) => runtime.tools().find(t => t.name === name).execute('call_test', params, signal, undefined, context);
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); await rm(sessionDir, { recursive: true, force: true }); await rm(isolate, { recursive: true, force: true }); });
  return { root, runtime, context, call, persisted, events, requests, agentDir: isolate };
}
export const callTool = (name, args, callId = 'mock_call') => [{ type: 'toolCall', id: callId, name, arguments: args }];
export const lastText = context => {
  const message = context.messages.at(-1); return typeof message?.content === 'string' ? message.content : message?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
};
export async function sessionFixture(t, handler, extraFactories = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-codex-profile-'));
  const agentDir = path.join(root, 'profile'); const requests = [];
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent-home');
  const configPath = path.join(root, 'config.json'); await writeFile(configPath, JSON.stringify({ sandbox: 'none' }));
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  const stream = mockStream(handler, requests);
  models.registerNativeProvider({ id: 'mock', name: 'mock', api: model.api, baseUrl: model.baseUrl, getModels: () => [model], stream, streamSimple: stream, auth: { apiKey: {
    name: 'Offline mock', resolve: async () => ({ auth: { apiKey: 'offline-mock-only' }, source: 'fixture' }), check: async () => ({ type: 'api_key', source: 'fixture' }),
  } } });
  await models.setRuntimeApiKey('mock', 'offline-mock-only');
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    systemPrompt: 'USER CUSTOM PROMPT. Follow project rules.', extensionFactories: [async pi => {
      const getFlag = pi.getFlag.bind(pi); pi.getFlag = name => name === 'codex-config' ? configPath : getFlag(name); await codexFlavor(pi);
    }, ...extraFactories] });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0, JSON.stringify(loader.getExtensions().errors));
  const sessionManager = SessionManager.create(root, path.join(root, 'sessions'));
  const { session } = await createAgentSession({ cwd: root, agentDir, model, modelRuntime: models, sessionManager, settingsManager: settings, resourceLoader: loader });
  await session.bindExtensions({ mode: 'print' });
  t.after(async () => { await session.abort(); await session.extensionRunner?.emit?.({ type: 'session_shutdown' }); session.dispose(); if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; await rm(root, { recursive: true, force: true }); });
  return { session, sessionManager, loader, root, agentHome: process.env.PI_CODING_AGENT_DIR, requests };
}
