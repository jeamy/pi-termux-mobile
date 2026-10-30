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
import { openHarness, sessionStore, Subagent } from './common.mjs';

test('the 1.4 session registry commits and reopens with its explicit checkpoint policy', async t => {
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

test('the 1.4 subagent output reaches the parent model', async t => {
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
