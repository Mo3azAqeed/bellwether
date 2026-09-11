/** The setup wizard, served at GET /setup. A single static page (no build
 * step, no external requests except back to this same Worker) — deliberate,
 * since this is meant to work for someone who just cloned the repo and
 * doesn't want a frontend toolchain to stand up an admin page.
 *
 * Client-safe integration metadata (no `test` functions — those only run
 * server-side) is injected into the page at request time by
 * src/setup/handlers.ts, built from the single INTEGRATIONS registry in
 * src/setup/integrations.ts so the UI can't drift out of sync with it. */

export interface ClientIntegration {
  id: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  instructions: string;
  fields: { key: string; label: string; placeholder?: string; type?: string }[];
  hasTest: boolean;
}

export function renderSetupPage(integrations: ClientIntegration[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Bellwether setup</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 64px; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #f7f7f8; color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) { body { background: #17171a; color: #eee; } }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.sub { color: #666; margin: 0 0 28px; }
  @media (prefers-color-scheme: dark) { p.sub { color: #999; } }

  #login { max-width: 360px; margin: 80px auto; }
  #login input { width: 100%; padding: 10px 12px; font-size: 15px; border-radius: 8px; border: 1px solid #ccc; margin-bottom: 10px; background: inherit; color: inherit; }
  button { font-family: inherit; }
  .btn { padding: 10px 16px; font-size: 14px; border-radius: 8px; border: none; cursor: pointer; font-weight: 600; }
  .btn-primary { background: #5b4ee5; color: white; }
  .btn-primary:disabled { opacity: 0.5; cursor: default; }
  .btn-secondary { background: transparent; border: 1px solid #999; color: inherit; }

  h2.section { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: #888; margin: 28px 0 10px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
  .card {
    background: white; border: 1px solid #e2e2e5; border-radius: 10px; padding: 14px; cursor: pointer;
    display: flex; flex-direction: column; gap: 6px; text-align: left; font: inherit; color: inherit;
  }
  @media (prefers-color-scheme: dark) { .card { background: #232326; border-color: #333; } }
  .card:hover { border-color: #5b4ee5; }
  .card .top { display: flex; align-items: center; justify-content: space-between; }
  .card .icon { font-size: 22px; }
  .card .name { font-weight: 600; }
  .card .desc { font-size: 12.5px; color: #777; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #bbb; flex-shrink: 0; }
  .dot.connected { background: #2fae5f; }
  .dot.skipped { background: #d9a441; }
  .status-label { font-size: 11px; color: #999; }

  .panel { background: white; border: 1px solid #e2e2e5; border-radius: 10px; padding: 20px; }
  @media (prefers-color-scheme: dark) { .panel { background: #232326; border-color: #333; } }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 13px; margin-bottom: 4px; color: #555; }
  @media (prefers-color-scheme: dark) { .field label { color: #aaa; } }
  .field input { width: 100%; padding: 9px 10px; font-size: 14px; border-radius: 6px; border: 1px solid #ccc; background: inherit; color: inherit; }
  .instructions { font-size: 13.5px; color: #555; background: #f2f1fb; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
  @media (prefers-color-scheme: dark) { .instructions { color: #bbb; background: #1e1e2a; } }
  .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
  .result { margin-top: 12px; font-size: 13.5px; padding: 10px 12px; border-radius: 8px; display: none; }
  .result.ok { display: block; background: #e4f7ea; color: #1a7a3f; }
  .result.err { display: block; background: #fbeaea; color: #b23c3c; }
  @media (prefers-color-scheme: dark) { .result.ok { background: #123420; } .result.err { background: #3a1c1c; } }
  .back { background: none; border: none; color: inherit; opacity: 0.7; cursor: pointer; font-size: 13px; margin-bottom: 14px; padding: 0; }

  .radio-row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .radio-row label { display: flex; align-items: center; gap: 6px; border: 1px solid #ccc; border-radius: 8px; padding: 8px 12px; cursor: pointer; font-size: 14px; }
  .radio-row input { margin: 0; }
  .disclaimer { font-size: 12.5px; color: #888; margin-top: 6px; }

  [hidden] { display: none !important; }
</style>
</head>
<body>
<div class="wrap">

  <div id="login">
    <h1>Bellwether setup</h1>
    <p class="sub">Enter the admin token you set as SETUP_ADMIN_TOKEN.</p>
    <input id="tokenInput" type="password" placeholder="Admin token" onkeydown="if(event.key==='Enter') tryLogin()" />
    <button class="btn btn-primary" style="width:100%" onclick="tryLogin()">Unlock</button>
    <p id="loginError" class="result err" hidden></p>
  </div>

  <div id="app" hidden>
    <h1>Bellwether setup</h1>
    <p class="sub">Connect your data sources. Each one saves straight to your own database — nothing leaves your Cloudflare account.</p>

    <div id="dashboard">
      <h2 class="section">Usage data (pick one)</h2>
      <div class="grid" data-category="usage"></div>

      <h2 class="section">Context sources (the "Why?" answers)</h2>
      <div class="grid" data-category="context"></div>

      <h2 class="section">Answer quality (optional)</h2>
      <div class="grid" data-category="generation"></div>

      <h2 class="section">Slack</h2>
      <div class="panel">
        Required, set up separately (it needs a Slack app manifest, not just a key) —
        see the <a href="https://github.com/Mo3azAqeed/bellwether#deploy" target="_blank">README</a>.
      </div>

      <h2 class="section">Alerts</h2>
      <div class="panel">
        <p style="margin-top:0">Post here when an account's health tier changes (e.g. Stable &rarr; Watch). Leave blank to disable.</p>
        <div class="field">
          <label>Slack channel ID (not name — e.g. C0123456789)</label>
          <input id="alertsChannelInput" placeholder="C0123456789" />
        </div>
        <button class="btn btn-primary" onclick="saveAlertsChannel()">Save</button>
        <p id="alertsResult" class="result"></p>
      </div>

      <h2 class="section">Sync frequency</h2>
      <div class="panel">
        <p style="margin-top:0">How often to re-check usage numbers and pull in new context (support tickets, CRM notes) for accounts nobody's asked about. Live <code>@Bell how is X doing?</code> queries always run fresh regardless of this setting.</p>
        <div class="radio-row" id="frequencyRadios">
          <label><input type="radio" name="freq" value="4" /> Every 4 hours</label>
          <label><input type="radio" name="freq" value="8" /> Every 8 hours</label>
          <label><input type="radio" name="freq" value="12" /> Every 12 hours</label>
          <label><input type="radio" name="freq" value="24" /> Once a day</label>
        </div>
        <p class="disclaimer">
          The Workers Paid plan ($5/mo, needed for the RAG features regardless of frequency) is flat, not metered —
          at typical account counts none of these push you past the free usage allowances bundled into it. The real
          cost driver is which model answers "Why?" questions: the free Workers AI default doesn't care how often it
          runs, but if you've connected Anthropic or OpenRouter, more frequent syncing can mean more model calls —
          that's the "may cost more" case, not the sync interval itself.
        </p>
        <button class="btn btn-primary" onclick="saveFrequency()">Save</button>
        <p id="freqResult" class="result"></p>
      </div>
    </div>

    <div id="detail" hidden>
      <button class="back" onclick="showDashboard()">&larr; Back</button>
      <div class="panel">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <span id="detailIcon" style="font-size:26px"></span>
          <h2 id="detailName" style="margin:0;font-size:18px"></h2>
        </div>
        <p id="detailDesc" class="sub" style="margin-bottom:14px"></p>
        <p id="detailInstructions" class="instructions"></p>
        <div id="detailFields"></div>
        <div class="actions">
          <button class="btn btn-primary" id="detailSaveBtn" onclick="testAndSave()">Test &amp; Connect</button>
          <button class="btn btn-secondary" onclick="skipIntegration()">Skip for now</button>
        </div>
        <p id="detailResult" class="result"></p>
      </div>
    </div>
  </div>
</div>

<script>
var INTEGRATIONS = ${JSON.stringify(integrations)};
var token = localStorage.getItem("bellwether_setup_token") || "";
var statusById = {};
var currentIntegration = null;

function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ "content-type": "application/json", Authorization: "Bearer " + token }, opts.headers || {});
  return fetch(path, opts).then(function (r) {
    return r.json().then(function (body) { return { status: r.status, body: body }; });
  });
}

function tryLogin() {
  token = document.getElementById("tokenInput").value;
  api("/setup/api/status").then(function (res) {
    if (res.status !== 200) {
      document.getElementById("loginError").hidden = false;
      document.getElementById("loginError").textContent = "That token was rejected.";
      return;
    }
    localStorage.setItem("bellwether_setup_token", token);
    document.getElementById("login").hidden = true;
    document.getElementById("app").hidden = false;
    applyStatus(res.body);
  });
}

function applyStatus(body) {
  statusById = {};
  (body.integrations || []).forEach(function (i) { statusById[i.id] = i; });
  renderDashboard();
  var freqRadio = document.querySelector('input[name="freq"][value="' + body.syncFrequencyHours + '"]');
  if (freqRadio) freqRadio.checked = true;
  document.getElementById("alertsChannelInput").value = body.alertsChannel || "";
}

function renderDashboard() {
  ["usage", "context", "generation"].forEach(function (category) {
    var container = document.querySelector('.grid[data-category="' + category + '"]');
    container.innerHTML = "";
    INTEGRATIONS.filter(function (i) { return i.category === category; }).forEach(function (integration) {
      var s = statusById[integration.id] || {};
      var dotClass = s.connected ? "connected" : (s.skipped ? "skipped" : "");
      var statusLabel = s.connected ? "Connected" : (s.skipped ? "Skipped" : "Not set up");
      var card = document.createElement("button");
      card.className = "card";
      card.onclick = function () { openIntegration(integration.id); };
      card.innerHTML =
        '<div class="top"><span class="icon">' + integration.icon + '</span><span class="dot ' + dotClass + '"></span></div>' +
        '<span class="name">' + integration.name + '</span>' +
        '<span class="desc">' + integration.description + '</span>' +
        '<span class="status-label">' + statusLabel + '</span>';
      container.appendChild(card);
    });
  });
}

function openIntegration(id) {
  currentIntegration = INTEGRATIONS.find(function (i) { return i.id === id; });
  document.getElementById("dashboard").hidden = true;
  document.getElementById("detail").hidden = false;
  document.getElementById("detailIcon").textContent = currentIntegration.icon;
  document.getElementById("detailName").textContent = currentIntegration.name;
  document.getElementById("detailDesc").textContent = currentIntegration.description;
  document.getElementById("detailInstructions").textContent = currentIntegration.instructions;
  document.getElementById("detailSaveBtn").textContent = currentIntegration.hasTest ? "Test & Connect" : "Save";
  var result = document.getElementById("detailResult");
  result.className = "result";
  result.textContent = "";

  var fieldsEl = document.getElementById("detailFields");
  fieldsEl.innerHTML = "";
  currentIntegration.fields.forEach(function (f) {
    var wrap = document.createElement("div");
    wrap.className = "field";
    var label = document.createElement("label");
    label.textContent = f.label;
    var input = document.createElement("input");
    input.type = f.type === "password" ? "password" : "text";
    input.id = "field_" + f.key;
    if (f.placeholder) input.placeholder = f.placeholder;
    wrap.appendChild(label);
    wrap.appendChild(input);
    fieldsEl.appendChild(wrap);
  });
}

function showDashboard() {
  document.getElementById("detail").hidden = true;
  document.getElementById("dashboard").hidden = false;
}

function testAndSave() {
  var values = {};
  currentIntegration.fields.forEach(function (f) {
    values[f.key] = document.getElementById("field_" + f.key).value;
  });
  var btn = document.getElementById("detailSaveBtn");
  btn.disabled = true;
  api("/setup/api/test-and-save", { method: "POST", body: JSON.stringify({ integrationId: currentIntegration.id, values: values }) })
    .then(function (res) {
      btn.disabled = false;
      var result = document.getElementById("detailResult");
      result.className = "result " + (res.body.ok ? "ok" : "err");
      result.textContent = res.body.message || (res.body.ok ? "Saved." : "Something went wrong.");
      if (res.body.ok) {
        return api("/setup/api/status").then(function (r) { applyStatus(r.body); });
      }
    });
}

function skipIntegration() {
  api("/setup/api/skip", { method: "POST", body: JSON.stringify({ integrationId: currentIntegration.id }) }).then(function () {
    return api("/setup/api/status").then(function (r) { applyStatus(r.body); showDashboard(); });
  });
}

function saveFrequency() {
  var selected = document.querySelector('input[name="freq"]:checked');
  if (!selected) return;
  api("/setup/api/frequency", { method: "POST", body: JSON.stringify({ hours: Number(selected.value) }) }).then(function (res) {
    var el = document.getElementById("freqResult");
    el.className = "result " + (res.body.ok ? "ok" : "err");
    el.textContent = res.body.ok ? "Saved." : (res.body.error || "Something went wrong.");
  });
}

function saveAlertsChannel() {
  var channel = document.getElementById("alertsChannelInput").value;
  api("/setup/api/alerts-channel", { method: "POST", body: JSON.stringify({ channel: channel }) }).then(function (res) {
    var el = document.getElementById("alertsResult");
    el.className = "result " + (res.body.ok ? "ok" : "err");
    el.textContent = res.body.ok ? "Saved." : (res.body.error || "Something went wrong.");
  });
}

if (token) {
  api("/setup/api/status").then(function (res) {
    if (res.status === 200) {
      document.getElementById("login").hidden = true;
      document.getElementById("app").hidden = false;
      applyStatus(res.body);
    }
  });
}
</script>
</body>
</html>`;
}
