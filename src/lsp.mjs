import { pathToFileURL, fileURLToPath } from 'node:url';
import { id, deferred, checkAbort } from './util.mjs';
export class JsonRpc {
  constructor(write, onNotification = () => {}) { this.write = write; this.onNotification = onNotification; this.buffer = Buffer.alloc(0); this.pending = new Map(); this.sequence = 0; this.closed = false; }
  send(value) { const body = Buffer.from(JSON.stringify(value)); this.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])); }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method, params, signal) {
    if (this.closed) return Promise.reject(Error('Language server closed')); checkAbort(signal);
    const requestId = ++this.sequence; const wait = deferred();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.pending.delete(requestId); };
    const cancel = () => { this.notify('$/cancelRequest', { id: requestId }); cleanup(); wait.reject(Error('LSP request cancelled')); };
    const timer = setTimeout(() => { cleanup(); wait.reject(Error(`LSP timeout: ${method}`)); }, 15000);
    this.pending.set(requestId, { ...wait, cleanup }); signal?.addEventListener('abort', cancel, { once: true });
    try { this.send({ jsonrpc: '2.0', id: requestId, method, params }); } catch (error) { cleanup(); wait.reject(error); }
    return wait.promise;
  }
  feed(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > 2 * 1024 * 1024) throw Error('Language server frame exceeds limit');
    while (true) {
      const boundary = this.buffer.indexOf('\r\n\r\n'); if (boundary < 0) return;
      const length = /(?:^|\r\n)Content-Length: (\d+)(?:\r\n|$)/i.exec(this.buffer.subarray(0, boundary).toString())?.[1];
      if (length === undefined || Number(length) > 1024 * 1024) throw Error('Invalid LSP Content-Length');
      const end = boundary + 4 + Number(length); if (this.buffer.length < end) return;
      const message = JSON.parse(this.buffer.subarray(boundary + 4, end).toString('utf8')); this.buffer = this.buffer.subarray(end);
      if (message.method) {
        if (message.id !== undefined) this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Server-initiated execution and workspace edits are disabled' } });
        else this.onNotification(message.method, message.params);
      } else {
        const pending = this.pending.get(message.id); if (!pending) continue; pending.cleanup();
        if (message.error) pending.reject(Error(message.error.message)); else pending.resolve(message.result);
      }
    }
  }
  close(reason = 'Language server closed') { this.closed = true; for (const entry of [...this.pending.values()]) { entry.cleanup(); entry.reject(Error(reason)); } }
}
export class Lsp {
  constructor({ config, policy, executor, files }) { Object.assign(this, { config, policy, executor, files }); this.servers = new Map(); this.previews = new Map(); }
  async server(name, owner, signal) {
    const key = `${owner}:${name}`; if (this.servers.has(key)) return this.servers.get(key);
    const definition = this.config.lsp.find(item => item.name === name); if (!definition) throw Error('Language server is not configured for this session');
    const promise = (async () => {
      const diagnostics = new Map(); let rpc;
      const job = await this.executor.launch(definition.command, { owner, signal, readOnly: true, requireApproval: true, description: `Start language server ${name}: ${definition.command.join(' ')}`, onStderr: () => {},
        onData: data => { try { rpc?.feed(data); } catch (error) { rpc?.close(error.message); this.executor.kill(job); } }, timeoutMs: 3600000 });
      rpc = new JsonRpc(data => job.child.stdin.write(data), (method, params) => {
        if (method === 'textDocument/publishDiagnostics' && typeof params?.uri === 'string') {
          if (diagnostics.size >= 128) diagnostics.delete(diagnostics.keys().next().value);
          diagnostics.set(params.uri, (params.diagnostics ?? []).slice(0, 100));
        }
      });
      job.promise.then(() => { rpc.close(); this.servers.delete(key); });
      const server = { job, rpc, diagnostics, documents: new Map(), definition };
      try {
        await rpc.request('initialize', { processId: null, rootUri: pathToFileURL(this.policy.root).href, capabilities: { workspace: { applyEdit: false }, textDocument: { synchronization: { didSave: false }, codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor'] } } } } } }, signal);
        rpc.notify('initialized', {}); return server;
      } catch (error) { this.executor.kill(job); throw error; }
    })();
    this.servers.set(key, promise);
    try { return await promise; } catch (error) { this.servers.delete(key); throw error; }
  }
  async query(params, owner, signal) {
    const target = await this.policy.path(params.path, { owner });
    const definition = params.server ? this.config.lsp.find(s => s.name === params.server) : this.config.lsp.find(s => s.extensions.some(ext => target.endsWith(ext)));
    if (!definition) throw Error('No language server configured for this file');
    const server = await this.server(definition.name, owner, signal);
    const uri = pathToFileURL(target).href; const text = (await this.files.safe.read(target, owner)).data.toString('utf8');
    const document = server.documents.get(uri);
    if (!document) { server.rpc.notify('textDocument/didOpen', { textDocument: { uri, languageId: definition.languageId ?? definition.name, version: 1, text } }); server.documents.set(uri, { version: 1, text }); }
    else if (document.text !== text) { document.version++; document.text = text; server.rpc.notify('textDocument/didChange', { textDocument: { uri, version: document.version }, contentChanges: [{ text }] }); }
    if (params.method === 'diagnostics') return { uri, diagnostics: server.diagnostics.get(uri) ?? [], note: 'Latest bounded server publication; absence does not prove a clean build' };
    const method = { definition: 'textDocument/definition', references: 'textDocument/references', hover: 'textDocument/hover', symbols: 'textDocument/documentSymbol', code_actions: 'textDocument/codeAction' }[params.method];
    if (!method) throw Error('Unsupported LSP method');
    const position = { line: params.line ?? 0, character: params.character ?? 0 };
    const request = { textDocument: { uri }, position };
    if (params.method === 'references') request.context = { includeDeclaration: true };
    if (params.method === 'code_actions') { request.range = { start: position, end: position }; request.context = { diagnostics: server.diagnostics.get(uri) ?? [] }; }
    const response = await server.rpc.request(method, request, signal);
    if (params.method !== 'code_actions') return response;
    const actions = [];
    for (const action of (response ?? []).slice(0, 30)) {
      if (action.command || !action.edit) { actions.push({ title: action.title, unavailable: 'Commands and unresolved actions are never executed' }); continue; }
      const preview = await this.preview(action.edit, owner);
      actions.push({ title: action.title, ...preview });
    }
    return actions;
  }
  async preview(workspaceEdit, owner) {
    if (workspaceEdit.documentChanges?.some(change => !change.textDocument || !change.edits)) throw Error('LSP resource operations are unsupported');
    const changes = Object.entries(workspaceEdit.changes ?? {});
    for (const change of workspaceEdit.documentChanges ?? []) changes.push([change.textDocument.uri, change.edits]);
    const planned = []; const expected = {};
    for (const [uri, edits] of changes) {
      const target = await this.policy.path(fileURLToPath(uri), { owner });
      if (planned.some(p => p.path === target)) throw Error('Duplicate LSP document edits');
      const text = (await this.files.safe.read(target, owner)).data.toString('utf8'); const lines = text.split('\n');
      const offset = point => {
        if (!Number.isInteger(point.line) || point.line < 0 || point.line >= lines.length || !Number.isInteger(point.character) || point.character < 0 || point.character > lines[point.line].replace(/\r$/, '').length) throw Error('Invalid LSP edit range');
        return lines.slice(0, point.line).reduce((sum, line) => sum + line.length + 1, 0) + point.character;
      };
      const ranges = edits.map(edit => ({ start: offset(edit.range.start), end: offset(edit.range.end), text: edit.newText })).sort((a, b) => b.start - a.start);
      let next = text; let last = text.length + 1;
      for (const range of ranges) {
        if (range.start > range.end || range.end > last) throw Error('Overlapping LSP edits'); last = range.start;
        next = next.slice(0, range.start) + range.text + next.slice(range.end);
      }
      Object.assign(expected, await this.files.capture([target], owner, false)); planned.push({ path: target, content: next });
    }
    if (!planned.length) throw Error('LSP action contains no edits');
    const previewId = id('lsp_preview'); this.previews.set(previewId, { owner, expected, planned });
    if (this.previews.size > 64) this.previews.delete(this.previews.keys().next().value);
    return { preview_id: previewId, files: planned };
  }
  async apply(previewId, owner, signal) {
    const preview = this.previews.get(previewId); if (!preview || preview.owner !== owner) throw Error('Unknown code action preview');
    const response = await this.files.mutate(preview.planned.map(p => p.path), owner, async () => {
      for (const item of preview.planned) { checkAbort(signal); await this.files.safe.write(item.path, item.content, owner); }
    }, { signal, expected: preview.expected, label: `LSP action ${previewId}` });
    this.previews.delete(previewId); return response;
  }
  async close() {
    for (const promise of this.servers.values()) { const server = await promise.catch(() => null); if (server) { server.rpc.close(); this.executor.kill(server.job); await server.job.promise; } }
    this.servers.clear(); this.previews.clear();
  }
}
