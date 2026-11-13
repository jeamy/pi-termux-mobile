// Every page in both languages: each text the pages show is in the table of public/i18n.js, in English and German.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { known, pairs, t } from './public/i18n.js';

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'public');
const files = (ext) => fs.readdirSync(DIR).filter((f) => f.endsWith(ext)).map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const norm = (s) => s.replace(/\s+/g, ' ').trim();
/** Text that is the same in both languages: names, keys of the terminal bar, symbols. */
const SAME = new Set(['pi mobile', 'pi cli', 'pi mobile — Spaces', 'Spaces', 'Chat', 'Remote', 'CLI', 'Clients', 'Space',
  'esc', 'ctrl', 'pg↑', 'pg↓', 'user@host[:port]', 'tcp://192.168.8.28:PORT', 'Main', 'OAuth', 'Anthropic', 'OpenAI', 'Google',
  'OpenRouter', 'Mistral', 'Groq', 'DeepSeek', 'xAI', 'MiniMax', 'zai', 'Host', 'Members', 'space-id-1, space-id-2']);
const textual = (s) => /[A-Za-zÄÖÜäöü]{2,}/.test(s) && !SAME.has(s);

function pageTexts(html) {
  const out = { text: [], html: [], attr: [] };
  let body = html.replace(/<(\w+)\b[^>]*\bdata-i18n-html\b[^>]*>([\s\S]*?)<\/\1>/g, (m, tag, inner) => { out.html.push(norm(inner)); return '<x>'; });
  body = body.replace(/<(script|style|pre|textarea|code)\b[^>]*>[\s\S]*?<\/\1>/g, '<x>');
  for (const [, s] of html.matchAll(/\b(?:placeholder|title|aria-label)="([^"]*)"/g)) out.attr.push(norm(decode(s)));
  for (const [, s] of body.matchAll(/>([^<]+)</g)) if (norm(s)) out.text.push(norm(decode(s)));
  return out;
}

test('i18n: every text of the static pages has both languages', () => {
  const missing = [];
  for (const [file, html] of files('.html')) {
    const { text, html: blocks, attr } = pageTexts(html);
    for (const s of [...text, ...attr]) if (textual(s) && !known(s)) missing.push(`${file}: ${s}`);
    for (const s of blocks) if (!known(s)) missing.push(`${file} (data-i18n-html): ${s}`);
  }
  assert.deepEqual(missing, []);
});

test('i18n: a paragraph with markup is marked data-i18n-html, so it is translated as a whole', () => {
  const unmarked = [];
  for (const [file, html] of files('.html')) {
    for (const [, attrs, inner] of html.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
      if (/<(b|code|i|em|strong|a)\b/.test(inner) && !/data-i18n-html/.test(attrs)) unmarked.push(`${file}: ${norm(inner).slice(0, 60)}`);
    }
  }
  assert.deepEqual(unmarked, []);
});

test('i18n: every text the scripts pass to t() has both languages', () => {
  const missing = [];
  for (const [file, js] of files('.js')) {
    if (file === 'i18n.js') continue;
    for (const [, q, s] of js.matchAll(/(?<![\w.])(?:t|tr)\((['`])((?:\\.|(?!\1).)*)\1/g)) {
      const text = s.replace(/\\n/g, '\n').replace(/\\'/g, "'");
      if (q === '`' && text.includes('${')) { missing.push(`${file}: template ${text}`); continue; }
      if (!known(text)) missing.push(`${file}: ${text}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('i18n: both sides of a pair name the same placeholders and the same markup', () => {
  const bad = [];
  const marks = (s) => [...s.matchAll(/\{(\w+)\}|<(\/?\w+)/g)].map((m) => m[1] ?? m[2]).sort().join(',');
  for (const [en, de] of pairs) {
    if (marks(en) !== marks(de)) bad.push(`${en} | ${de}`);
    if (!en.trim() || !de.trim()) bad.push(`empty: ${en} | ${de}`);
  }
  assert.deepEqual(bad, []);
});

test('i18n: a German text of the German pages stands for one English text only', () => {
  const english = new Map();
  for (const [en, de] of pairs) { const k = norm(de); english.set(k, [...new Set([...(english.get(k) ?? []), en])]); }
  const used = [];
  for (const file of ['spaces.html', 'steuerung.html']) {
    const { text, html, attr } = pageTexts(fs.readFileSync(path.join(DIR, file), 'utf8'));
    used.push(...text, ...html, ...attr);
  }
  const ambiguous = used.filter((s) => (english.get(s) ?? []).length > 1).map((s) => `${s}: ${english.get(s).join(' / ')}`);
  assert.deepEqual(ambiguous, []);
});

test('i18n: t() fills placeholders and leaves unknown text as it is', () => {
  assert.equal(t('connecting {target}…', { target: 'h' }).includes('h'), true);
  assert.equal(t('no such text {x}', { x: 1 }), 'no such text 1');
});
