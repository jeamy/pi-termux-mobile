import { t } from './i18n.js';
// One modal implementation for security decisions. Never interpolate remote text as HTML.
function ask(message, yes, no, danger = false) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    const text = document.createElement('p');
    text.textContent = message;
    if (danger) text.className = 'danger-text';
    const row = document.createElement('div');
    row.className = 'modal-row';
    const done = (v) => { overlay.remove(); resolve(v); };
    for (const [label, v] of [[yes, true], [no, false]]) {
      const button = document.createElement('button');
      button.textContent = label;
      if (v && danger) button.className = 'danger-btn';
      button.addEventListener('click', () => done(v));
      row.appendChild(button);
    }
    box.append(text, row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}
export const askTrustHost = (target, fingerprint) => ask(
  t('Verify the SSH host fingerprint for {target} OUTSIDE this app before continuing: {fp}. A fake host could steal all API keys and OAuth tokens from this phone. Do you trust this fingerprint?', { target, fp: fingerprint }),
  t('Fingerprint verified'), t('Cancel'), true);
export const askCopyAuth = (target) => ask(
  t('WARNING: {target} has no auth.json. Copy ALL API keys and OAuth tokens stored on this phone to the host? Anyone with access to that host could use them.', { target }),
  t('Yes, copy'), t('No'), true);
export const askInstallKey = (target) => ask(
  t('{target} does not accept this device\'s SSH key. Install it with ssh-copy-id? You will be asked for the host password once.', { target }),
  t('Yes, install key'), t('No'));
export const askUpdate = (target, info) => ask(
  t('pi-serverd on {target} is outdated ({installed} → {available}). Update it now? Running work is interrupted; durable sessions resume afterwards.', { target, installed: info.installed || t('unknown'), available: info.available }),
  t('Yes, update'), t('No, keep old version'));
