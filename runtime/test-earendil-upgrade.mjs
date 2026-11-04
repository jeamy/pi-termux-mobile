// Offline checks of the 1.4 Harness integration; no existing state or credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { openHarness, sessionStore, Subagent, watchEvents, createEventHub, ensureModel } from './common.mjs';

test('the 1.5 session registry commits and reopens with its explicit checkpoint policy', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-upgrade-registry-'));
  const dbPath = path.join(dir, 'harness.sqlite');
  const models = createModels();
  let harness;
  t.after(async () => {
    try { await harness?.close(ctx); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  harness = await openHarness({ dbPath, models }, ctx);
  const sessions = sessionStore(harness, ctx);
  const conversation = await sessions.create({ name: 'before' });
  await sessions.update(conversation.id, { name: 'after' });
  await sessions.setActive(conversation.id);
  await harness.close(ctx);
  harness = undefined;
  harness = await openHarness({ dbPath, models }, ctx);
  const reopened = sessionStore(harness, ctx);
  assert.equal((await reopened.get(conversation.id)).name, 'after');
  assert.equal(await reopened.activeId(), String(conversation.id));
});

test('the 1.5 subagent output reaches the parent model', async t => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(Subagent);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' }, extensions: [Subagent] },
  });
  let output = '';
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('subagent', { task: 'answer' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('child answer'),
    context => {
      const result = context.messages.filter(m => m.role === 'toolResult').at(-1);
      output = result?.content.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';
      return fauxAssistantMessage('received');
    },
  ]);
  const settled = await (await root.submit({ type: 'input', content: 'delegate' }, ctx)).wait(ctx);
  assert.equal(settled.status, 'done');
  assert.equal(output, 'child answer');
});

test('1.5 watches retain history across windows and deliver self-contained snapshots to late pollers', { timeout: 15_000 }, async t => {
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 60 }, (_, i) => fauxAssistantMessage(`answer ${i}`)));
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
  const hub = createEventHub(harness, ctx, { ringSize: 2 });
  t.after(async () => { await hub.close(); await harness.close(ctx); });
  const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  assert.deepEqual(await ensureModel(root, models, ctx), { provider: 'faux', modelId: 'faux-1' });
  const position = await hub.position(root.id);
  for (let i = 0; i < 60; i++) {
    const result = await (await root.submit({ type: 'input', content: `question ${i}` }, ctx)).wait(ctx);
    assert.equal(result.status, 'done');
  }
  const stream = await watchEvents(harness, root.id, ctx);
  try {
    assert.equal(stream.snapshot.entries.length, 120);
    assert.equal(stream.snapshot.entries[0].model[0].content, 'question 0');
    assert.equal(stream.snapshot.run, undefined);
  } finally { await stream.stop(); }
  const deadline = Date.now() + 2000;
  for (;;) {
    const result = await hub.poll(root.id, position.cursor, { epoch: position.epoch, waitMs: 0 });
    assert.equal(result.reset, false);
    const snapshot = result.events.at(-1);
    if (snapshot?.entries.length === 120 && !snapshot.run) break;
    assert.ok(Date.now() < deadline, 'the latest snapshot did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
});
