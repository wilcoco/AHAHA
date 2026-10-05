const llmStyles = `<style>
.llm-panel{font-family:system-ui,sans-serif}.llm-panel h2{font-family:Georgia,serif;margin:0 0 8px;font-size:28px}.llm-panel h3{font-size:16px;margin:0 0 8px}.llm-help{font-size:14px;color:var(--muted);margin:8px 0 16px}.llm-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.llm-box{border:1px solid var(--line);border-radius:12px;padding:18px;min-width:0}.llm-status{font-size:14px;overflow-wrap:anywhere}.llm-status[data-configured="true"]{color:var(--accent)}.llm-field{display:grid;gap:7px;font-size:14px;font-weight:600;margin:14px 0}.llm-panel input,.llm-panel select,.llm-panel textarea{width:100%;min-width:0;font:16px/1.5 system-ui,sans-serif;color:var(--ink);background:var(--paper);padding:11px 12px;border:1px solid var(--line);border-radius:9px}.llm-panel input:focus,.llm-panel select:focus,.llm-panel textarea:focus{outline:2px solid var(--accent);outline-offset:2px}.llm-panel button{cursor:pointer}.llm-panel button:disabled,.llm-panel input:disabled,.llm-panel select:disabled{opacity:.55;cursor:not-allowed}.llm-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.llm-secondary{border:1px solid var(--line);border-radius:9px;background:transparent;color:var(--ink);padding:10px 15px;font-weight:600}.llm-notice{font-size:14px;min-height:1.5em;margin:12px 0 0;overflow-wrap:anywhere}.llm-notice[data-error="true"]{color:#973b2f}.llm-divider{border:0;border-top:1px solid var(--line);margin:24px 0}.chat-hero{padding:44px 0 14px}.chat-hero h1{font-size:clamp(40px,7vw,62px);margin:8px 0;line-height:1.1;letter-spacing:-.04em}.chat-toolbar{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap}.chat-toolbar .llm-field{flex:1;margin:0;min-width:180px}.chat-transcript{min-height:200px;max-height:60vh;overflow-y:auto;padding:16px 0;margin:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.chat-empty{color:var(--muted);font-family:Georgia,serif;font-size:21px;text-align:center;padding:36px 12px}.chat-message{padding:16px;border-radius:12px;margin:0 0 12px;border:1px solid var(--line);background:var(--paper)}.chat-message[data-role="user"]{background:#edf1e9;margin-left:24px}.chat-message[data-role="assistant"]{margin-right:24px}.chat-message p{white-space:pre-wrap;overflow-wrap:anywhere;font:16px/1.65 system-ui,sans-serif;margin:7px 0 0}.chat-composer textarea{resize:vertical;min-height:104px}.chat-composer .llm-field{margin:0 0 8px}.chat-composer .llm-actions{justify-content:space-between}.chat-count{font-size:12px;color:var(--muted)}.llm-link{color:var(--accent);font-size:14px}.llm-loading{color:var(--muted);font-size:14px}@media(max-width:600px){.llm-grid{grid-template-columns:1fr}.llm-panel{padding:18px}.chat-message[data-role="user"]{margin-left:10px}.chat-message[data-role="assistant"]{margin-right:10px}.chat-toolbar{align-items:stretch}.chat-toolbar .llm-secondary{align-self:flex-end}.chat-transcript{max-height:55vh}}
</style>`;

export const providerOptions = `<option value="auto">Auto — prefer hosted</option><option value="hosted_openai">OpenAI · Hosted</option><option value="hosted_anthropic">Anthropic · Hosted</option><option value="byok_openai">OpenAI · My API key</option><option value="byok_anthropic">Anthropic · My API key</option>`;

export const clientHelpers = String.raw`
  const labels = {auto: 'Auto — prefer hosted', hosted_openai: 'OpenAI · Hosted', hosted_anthropic: 'Anthropic · Hosted', byok_openai: 'OpenAI · My API key', byok_anthropic: 'Anthropic · My API key'};
  const notice = (element, message, isError = false) => { element.textContent = message; element.dataset.error = String(isError); };
  const available = (settings, provider) => {
    if (provider === 'auto') return settings.hosted.openai.configured || settings.hosted.anthropic.configured || (settings.byok.enabled && (settings.byok.openai.configured || settings.byok.anthropic.configured));
    const [kind, name] = provider.split('_');
    return Boolean(settings[kind] && settings[kind][name] && settings[kind][name].configured && (kind !== 'byok' || settings.byok.enabled));
  };
  const fillProviders = (select, settings) => {
    for (const option of select.options) {
      const ready = available(settings, option.value);
      option.textContent = labels[option.value] + (option.value !== 'auto' && !ready ? ' · Not configured' : '');
      option.disabled = option.value !== 'auto' && !ready;
    }
  };
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(path, {method, credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, ...(data === undefined ? {} : {body: JSON.stringify(data)})});
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result && result.error && result.error.message || (response.status === 401 ? 'Your session has expired. Please sign in again.' : 'The request failed. Please try again.'));
    if (!result) throw new Error('The server returned an unexpected response. Please try again.');
    return result;
  };
`;

export function settingsPanel(): string {
  return `${llmStyles}<section class="panel llm-panel" id="llm-settings" aria-labelledby="llm-settings-title">
  <h2 id="llm-settings-title">AI settings</h2><p class="llm-help">Chat with a hosted model or use your own provider account.</p>
  <div class="llm-grid"><div class="llm-box"><h3>OpenAI hosted</h3><div id="hosted-openai-status" class="llm-status">Checking configuration…</div></div><div class="llm-box"><h3>Anthropic hosted</h3><div id="hosted-anthropic-status" class="llm-status">Checking configuration…</div></div></div>
  <hr class="llm-divider"><h3>Your API keys</h3><p class="llm-help">Keys are encrypted before storage. Only the last four characters are shown. Your provider bills usage to your account.</p><p id="byok-availability" class="llm-help"></p>
  <div class="llm-grid">${["openai", "anthropic"].map(name => `<form id="key-${name}-form" class="llm-box"><h3>${name === "openai" ? "OpenAI" : "Anthropic"}</h3><div id="key-${name}-status" class="llm-status">Checking saved key…</div><label class="llm-field" for="key-${name}-input">New API key<input id="key-${name}-input" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="1024" placeholder="Paste API key" disabled required></label><div class="llm-actions"><button class="btn" id="key-${name}-save" type="submit" disabled>Save key</button><button class="llm-secondary" id="key-${name}-delete" type="button" disabled>Delete</button></div><p id="key-${name}-notice" class="llm-notice" role="status" aria-live="polite"></p></form>`).join("")}</div>
  <hr class="llm-divider"><form id="llm-provider-form"><label class="llm-field" for="llm-provider">Default chat provider<select id="llm-provider" disabled>${providerOptions}</select></label><p class="llm-help">Auto uses a configured hosted provider first, then an available saved key.</p><div class="llm-actions"><button id="llm-provider-save" class="btn" type="submit" disabled>Save preference</button><a href="/chat" class="llm-link">Open chat →</a></div></form><p id="llm-settings-notice" class="llm-notice" role="status" aria-live="polite">Loading AI settings…</p>
  </section><script>(() => {
  ${clientHelpers}
  const select = document.getElementById('llm-provider');
  const status = document.getElementById('llm-settings-notice');
  const busyProviders = new Set();
  let settings;
  let savingPreference = false;
  const render = () => {
    for (const provider of ['openai', 'anthropic']) {
      const hosted = settings.hosted[provider];
      const hostedStatus = document.getElementById('hosted-' + provider + '-status');
      hostedStatus.textContent = (hosted.configured ? 'Configured' : 'Not configured') + (hosted.configured && hosted.model ? ' · ' + hosted.model : '');
      hostedStatus.dataset.configured = String(hosted.configured);
      const saved = settings.byok[provider];
      const keyStatus = document.getElementById('key-' + provider + '-status');
      keyStatus.textContent = saved.configured ? 'Saved · ending in ' + saved.last4 : 'No key saved';
      keyStatus.dataset.configured = String(saved.configured);
      const busy = busyProviders.has(provider);
      document.getElementById('key-' + provider + '-input').disabled = busy || !settings.byok.enabled;
      document.getElementById('key-' + provider + '-save').disabled = busy || !settings.byok.enabled;
      document.getElementById('key-' + provider + '-save').textContent = busy ? 'Working…' : saved.configured ? 'Replace key' : 'Save key';
      document.getElementById('key-' + provider + '-delete').disabled = busy || !saved.configured;
    }
    document.getElementById('byok-availability').textContent = settings.byok.enabled ? '' : 'Saving and using keys is unavailable until the service owner configures BYOK encryption.';
    fillProviders(select, settings);
    select.disabled = savingPreference;
    document.getElementById('llm-provider-save').disabled = savingPreference;
  };
  const refresh = async () => { settings = await api('/api/llm/settings'); render(); };
  for (const provider of ['openai', 'anthropic']) {
    const input = document.getElementById('key-' + provider + '-input');
    const keyNotice = document.getElementById('key-' + provider + '-notice');
    const changeKey = async (method) => {
      if (!settings || busyProviders.has(provider)) return;
      const apiKey = method === 'PUT' ? input.value.trim() : undefined;
      if (method === 'PUT' && !apiKey) { notice(keyNotice, 'Enter an API key first.', true); return; }
      input.value = '';
      busyProviders.add(provider); render(); notice(keyNotice, method === 'PUT' ? 'Saving encrypted key…' : 'Deleting key…');
      try {
        await api('/api/llm/keys/' + provider, method, method === 'PUT' ? {apiKey} : undefined);
        await refresh();
        notice(keyNotice, method === 'PUT' ? 'Key saved.' : 'Key deleted.');
      } catch (error) { notice(keyNotice, error.message, true); }
      finally { busyProviders.delete(provider); render(); }
    };
    document.getElementById('key-' + provider + '-form').addEventListener('submit', event => { event.preventDefault(); void changeKey('PUT'); });
    document.getElementById('key-' + provider + '-delete').addEventListener('click', () => { void changeKey('DELETE'); });
  }
  document.getElementById('llm-provider-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!settings || savingPreference) return;
    savingPreference = true; render(); notice(status, 'Saving preference…');
    try { await api('/api/llm/settings', 'PUT', {provider: select.value}); await refresh(); select.value = settings.provider; notice(status, 'Default provider saved.'); }
    catch (error) { notice(status, error.message, true); }
    finally { savingPreference = false; render(); }
  });
  refresh().then(() => { select.value = settings.provider; notice(status, ''); }).catch(error => notice(status, error.message, true));
  })();</script>`;
}

export function chatSignInPage(): string {
  return `${llmStyles}<section class="chat-hero"><div class="kicker">A place to think</div><h1>Follow your question.</h1><p class="lede">Search related explorations, think with AI, and keep a map of your questions.</p></section><section class="panel llm-panel"><h2>Your conversation starts here.</h2><p>Sign in to save your conversations and use a hosted model or your own API key.</p><a class="btn" style="display:inline-block;text-decoration:none" href="/login">Create account / Sign in</a></section>`;
}
