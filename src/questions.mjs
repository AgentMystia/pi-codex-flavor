import { id, deferred, checkAbort, clone } from './util.mjs';
export function normalizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3) throw Error('Ask one to three questions');
  const used = new Set();
  return questions.map((question, index) => {
    const q = { ...question, id: question.id ?? `q${index + 1}`, question: question.question ?? question.title };
    if (!q.question?.trim() || used.has(q.id)) throw Error('Question text and unique ids are required'); used.add(q.id);
    if (q.options) {
      if (q.options.length < 2 || q.options.length > 6) throw Error('Provide two to six distinct options');
      q.options = q.options.map(option => typeof option === 'string' ? { label: option, description: '' } : option);
      if (q.options.some(o => !o.label?.trim()) || new Set(q.options.map(o => o.label)).size !== q.options.length) throw Error('Option labels must be unique');
    }
    return q;
  });
}
export class QuestionQueue {
  constructor({ state, dialogs, getUI, scheduler, deliver = () => {} }) {
    Object.assign(this, { state, dialogs, getUI, scheduler, deliver }); this.waiters = new Map(); this.controllers = new Map();
  }
  request(owner, questions, { async = false, signal, context = '', timeoutMs } = {}) {
    checkAbort(signal);
    const ui = this.getUI();
    if (!ui?.available) return { status: 'unavailable', reason: 'User questions require a TUI or RPC dialog channel' };
    const request = { id: id('question'), owner, context, questions: normalizeQuestions(questions), status: 'pending', async, createdAt: Date.now() };
    this.state.data.questions[request.id] = request; this.state.save();
    const wait = deferred(); this.waiters.set(request.id, wait);
    const controller = new AbortController(); this.controllers.set(request.id, controller);
    const cancel = () => this.cancel(request.id, 'cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = timeoutMs ? setTimeout(() => this.cancel(request.id, 'expired'), timeoutMs) : undefined;
    this.dialogs.run(async () => {
      if (request.status !== 'pending') return;
      const answers = {};
      for (const q of request.questions) {
        const title = `[${owner}] ${context ? context + '\n' : ''}${q.header ? q.header + ': ' : ''}${q.question}`;
        let answer;
        if (q.options) {
          const labels = q.options.map(o => o.label + (o.description ? ` — ${o.description}` : ''));
          const chosen = await ui.select(title, [...labels, '自由输入 / Free text'], { signal: controller.signal });
          if (chosen === undefined) { this.cancel(request.id); return; }
          const index = labels.indexOf(chosen);
          answer = index >= 0 ? q.options[index].label : await ui.input(title, '', { signal: controller.signal });
        } else answer = await ui.input(title, '', { signal: controller.signal });
        if (request.status !== 'pending') return;
        if (answer === undefined || !answer.trim()) { this.cancel(request.id); return; }
        answers[q.id] = { answers: [answer] };
      }
      this.answer(request.id, answers);
    }).catch(error => { this.cancel(request.id, 'unavailable', error.message); }).finally(() => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.controllers.delete(request.id);
    });
    return async ? { request_id: request.id, status: 'pending' } : this.scheduler.pause(owner, wait.promise, signal);
  }
  answer(requestId, answers) {
    const request = this.state.data.questions[requestId];
    if (!request || request.status !== 'pending') throw Error('Question is no longer pending');
    for (const q of request.questions) if (!answers[q.id]?.answers?.length || answers[q.id].answers.some(x => typeof x !== 'string' || !x.trim())) throw Error('Explicit answers are required for every question');
    request.answers = clone(answers); request.status = 'answered';
    this.state.data.decisions.push({ requestId, owner: request.owner, questions: clone(request.questions), answers: clone(answers), timestamp: Date.now() });
    this.finish(request);
  }
  cancel(requestId, status = 'cancelled', reason) {
    const request = this.state.data.questions[requestId];
    if (!request || request.status !== 'pending') return;
    request.status = status; request.reason = reason; this.controllers.get(requestId)?.abort(); this.finish(request);
  }
  finish(request) {
    this.state.save(); this.waiters.get(request.id)?.resolve(clone(request)); this.waiters.delete(request.id);
    if (request.async) this.deliver(request.owner, { type: 'user_input_response', request_id: request.id, status: request.status, answers: request.answers });
  }
  cancelOwner(owner) { for (const q of Object.values(this.state.data.questions)) if (q.owner === owner) this.cancel(q.id, 'invalidated'); }
  invalidateRestored() { for (const q of Object.values(this.state.data.questions)) if (q.status === 'pending') this.cancel(q.id, 'invalidated', 'Session restored; ask again to establish a live continuation'); }
  close() { for (const q of Object.values(this.state.data.questions)) this.cancel(q.id, 'invalidated'); }
}
