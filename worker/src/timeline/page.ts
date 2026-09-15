/** The account timeline, served at GET /timeline. Same shape as the setup
 * wizard: one static page, no build step, no external requests — it asks
 * this same Worker for JSON and renders it.
 *
 * The visual job is provenance. Every entry has to say where it came from
 * and let you go there, so the spine of the page is a single vertical rule
 * with the source on the left of it and the substance on the right. Reading
 * top to bottom is reading the account's recent history in order. */

export function renderTimelinePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Account timeline · Bellwether</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f7f8; --fg: #1a1a1a; --muted: #6b6b73; --card: #fff; --line: #e2e2e6;
    --accent: #5468ff; --at-risk: #d1453b; --watch: #c77700; --stable: #2f8a4c;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #17171a; --fg: #ededf0; --muted: #9a9aa4; --card: #1f1f24; --line: #32323a; --accent: #8f9cff; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 80px; background: var(--bg); color: var(--fg);
         font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  a { color: var(--accent); }

  #login { max-width: 360px; margin: 80px auto; }
  input, select { width: 100%; padding: 10px 12px; font: inherit; border-radius: 8px;
                  border: 1px solid var(--line); background: var(--card); color: inherit; }
  .btn { padding: 10px 16px; font: inherit; font-weight: 600; border-radius: 8px; border: none;
         background: var(--accent); color: #fff; cursor: pointer; margin-top: 10px; }

  .facts { display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 14px 16px; background: var(--card);
           border: 1px solid var(--line); border-radius: 10px; margin-bottom: 8px; }
  .facts div { font-size: 13px; }
  .facts b { display: block; color: var(--muted); font-weight: 500; font-size: 11px;
             text-transform: uppercase; letter-spacing: .04em; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .pill.at_risk { background: color-mix(in srgb, var(--at-risk) 16%, transparent); color: var(--at-risk); }
  .pill.watch   { background: color-mix(in srgb, var(--watch) 18%, transparent);   color: var(--watch); }
  .pill.stable  { background: color-mix(in srgb, var(--stable) 16%, transparent);  color: var(--stable); }

  /* The spine. Every entry hangs off one rule so the eye tracks one line. */
  .tl { position: relative; margin: 24px 0 0; padding: 0 0 0 92px; }
  .tl::before { content: ""; position: absolute; left: 76px; top: 6px; bottom: 6px; width: 2px; background: var(--line); }
  .ev { position: relative; margin-bottom: 22px; }
  .ev .when { position: absolute; left: -92px; width: 62px; text-align: right; font-size: 12px;
              color: var(--muted); font-variant-numeric: tabular-nums; padding-top: 11px; }
  .ev::before { content: ""; position: absolute; left: -18px; top: 17px; width: 9px; height: 9px;
                border-radius: 50%; background: var(--line); box-shadow: 0 0 0 3px var(--bg); }
  .ev.context::before { background: var(--accent); }
  .ev.tier::before    { background: var(--watch); }
  .ev.answer::before  { background: var(--muted); }

  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .src { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; flex-wrap: wrap; }
  .src .name { font-weight: 600; font-size: 13px; letter-spacing: .01em; }
  .src .meta { font-size: 12px; color: var(--muted); }
  .body { white-space: pre-wrap; }
  .go { font-size: 12px; font-weight: 600; text-decoration: none; }
  .go::after { content: " ↗"; }
  .q { font-weight: 600; margin-bottom: 4px; }
  .used { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--line); font-size: 12.5px; color: var(--muted); }
  .used a { text-decoration: none; }
  .empty { color: var(--muted); padding: 28px 0; }
  .err { color: var(--at-risk); }
  @media (max-width: 560px) {
    .tl { padding-left: 22px; }
    .tl::before { left: 6px; }
    .ev::before { left: -20px; }
    .ev .when { position: static; width: auto; text-align: left; padding: 0 0 3px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div id="login">
    <h1>Account timeline</h1>
    <p class="sub">Enter the admin token you set as <code>SETUP_ADMIN_TOKEN</code>.</p>
    <input id="token" type="password" placeholder="SETUP_ADMIN_TOKEN" autocomplete="current-password" />
    <button class="btn" id="signin">Open</button>
    <p class="err" id="loginerr"></p>
  </div>

  <div id="app" hidden>
    <h1 id="title">Account timeline</h1>
    <p class="sub">Where every piece of context came from, newest first.</p>
    <select id="picker"></select>
    <div id="facts"></div>
    <div id="tl"></div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let token = localStorage.getItem("bw_admin_token") || "";

async function api(path) {
  // No header when there's no token: running locally the Worker accepts it,
  // which is what makes the page open straight from a terminal with nothing
  // to type.
  const res = await fetch(path, token ? { headers: { Authorization: "Bearer " + token } } : {});
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error("Request failed (" + res.status + ")");
  return res.json();
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const dayOf = (at) => esc(String(at).slice(0, 10));

// No link is the normal case for several sources, so say nothing rather
// than printing "no link available" on every other card — an absent link
// is self-explanatory, and the repeated apology reads as a fault.
function link(url, label) {
  return url ? '<a class="go" href="' + esc(url) + '" target="_blank" rel="noopener">' + label + "</a>" : "";
}

function renderEvent(ev) {
  if (ev.kind === "context") {
    const count = ev.chunkCount > 1 ? " · " + ev.chunkCount + " chunks" : "";
    return '<div class="ev context"><div class="when">' + dayOf(ev.at) + '</div><div class="card">' +
      '<div class="src"><span class="name">' + esc(ev.source) + "</span>" +
      '<span class="meta">' + esc(ev.sourceRef || "") + count + "</span>" +
      link(ev.url, "Open in " + esc(ev.source)) + "</div>" +
      '<div class="body">' + esc(ev.excerpt) + "</div></div></div>";
  }
  if (ev.kind === "tier") {
    const from = ev.from ? esc(ev.from).replace("_", " ") + " → " : "first reading: ";
    return '<div class="ev tier"><div class="when">' + dayOf(ev.at) + '</div><div class="card">' +
      '<div class="src"><span class="name">Health tier</span></div>' +
      "<div>" + from + '<span class="pill ' + esc(ev.to) + '">' + esc(ev.to).replace("_", " ") + "</span></div>" +
      '<div class="meta" style="font-size:12.5px;color:var(--muted);margin-top:4px">' +
      ev.activeSeats + " active seats · " + (ev.deltaPct > 0 ? "+" : "") + ev.deltaPct + "% vs its own baseline</div>" +
      "</div></div>";
  }
  const used = ev.used.length
    ? '<div class="used">Built from: ' + ev.used.map((u) =>
        u.url ? '<a href="' + esc(u.url) + '" target="_blank" rel="noopener">' + esc(u.source) +
                (u.occurredAt ? " · " + dayOf(u.occurredAt) : "") + "</a>"
              : esc(u.source) + (u.occurredAt ? " · " + dayOf(u.occurredAt) : "")
      ).join(", ") + "</div>"
    : '<div class="used">Retrieval found nothing, so the answer had no notes to work from.</div>';

  return '<div class="ev answer"><div class="when">' + dayOf(ev.at) + '</div><div class="card">' +
    '<div class="src"><span class="name">Bell was asked</span><span class="meta">' +
    esc(ev.provider) + " · " + esc(ev.model) + "</span></div>" +
    '<div class="q">' + esc(ev.question) + "</div>" +
    '<div class="body">' + esc(ev.answer) + "</div>" + used + "</div></div>";
}

function renderFacts(a) {
  const tier = a.tier ? '<span class="pill ' + esc(a.tier) + '">' + esc(a.tier).replace("_", " ") + "</span>" : "—";
  $("facts").innerHTML = '<div class="facts">' +
    "<div><b>Tier</b>" + tier + "</div>" +
    "<div><b>Plan</b>" + esc(a.plan) + "</div>" +
    "<div><b>Seats</b>" + a.seatsPurchased + "</div>" +
    "<div><b>Renews</b>" + esc(a.renewalDate) + "</div>" +
    "<div><b>Owner</b>" + esc(a.owner || "unassigned") + "</div></div>";
}

async function show(accountId) {
  localStorage.setItem("bw_timeline_account", accountId);
  $("tl").innerHTML = '<p class="empty">Loading…</p>';
  const data = await api("/timeline/api/events?account=" + encodeURIComponent(accountId));
  $("title").textContent = data.account.name;
  renderFacts(data.account);
  $("tl").innerHTML = data.events.length
    ? '<div class="tl">' + data.events.map(renderEvent).join("") + "</div>"
    : '<p class="empty">Nothing on file for this account yet. Connect a source and its calls, tickets and CRM notes will appear here.</p>';
}

async function start() {
  const accounts = await api("/timeline/api/accounts");
  $("login").hidden = true;
  $("app").hidden = false;
  if (!accounts.length) {
    $("tl").innerHTML = '<p class="empty">No accounts loaded yet.</p>';
    return;
  }
  const remembered = localStorage.getItem("bw_timeline_account");
  const initial = accounts.some((a) => a.accountId === remembered) ? remembered : accounts[0].accountId;
  $("picker").innerHTML = accounts
    .map((a) => '<option value="' + esc(a.accountId) + '"' + (a.accountId === initial ? " selected" : "") + ">" + esc(a.name) + "</option>")
    .join("");
  $("picker").onchange = (e) => show(e.target.value);
  await show(initial);
}

$("signin").onclick = async () => {
  token = $("token").value.trim();
  try {
    await start();
    localStorage.setItem("bw_admin_token", token);
  } catch (err) {
    $("loginerr").textContent = err.message === "unauthorized" ? "That token wasn't accepted." : err.message;
  }
};
$("token").onkeydown = (e) => { if (e.key === "Enter") $("signin").click(); };

// Try unauthenticated first — locally that succeeds and there is nothing to
// log into. Deployed it 401s and the form appears.
start().catch(() => { /* needs a token, or the stored one is stale */ });
</script>
</body>
</html>`;
}
