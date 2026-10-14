"use strict";
// SF6 Tracker — site statique. Lit data/index.json et data/players/<sid>.json.

const BUCKLER = "https://www.streetfighter.com/6/buckler/profile/";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (t) => new Date(t * 1000).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const fmtDay = (d) => d.toISOString().slice(0, 10);
const pct = (w, n) => (n ? Math.round((100 * w) / n) : 0);
const LEAGUES = ["Rookie", "Iron", "Bronze", "Silver", "Gold", "Platinum", "Diamond"];
const leagueName = (r) => (r == null || r < 1 ? "Non classé" : r >= 36 ? "Master" : `${LEAGUES[Math.floor((r - 1) / 5)]} ${((r - 1) % 5) + 1}`);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const S = {
  index: null,
  sid: null,
  data: null, // { profile, matches }
  tab: store.get("tab", "progress"),
  metric: null,
  histLimit: 100,
  rival: null,
};

// ------------------------------------------------------------------ chargement
async function getJson(url) {
  // Sur GitHub Pages, on lit les données directement depuis le dépôt (toujours à jour, sans attendre le redéploiement).
  const h = location.hostname, repo = location.pathname.split("/").filter(Boolean)[0];
  const urls = h.endsWith(".github.io") && repo
    ? [`https://raw.githubusercontent.com/${h.split(".")[0]}/${repo}/main/${url}`, url]
    : [url];
  let err;
  for (const u of urls) {
    try {
      const r = await fetch(`${u}?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) return r.json();
      err = new Error(`${u} : ${r.status}`);
    } catch (e) { err = e; }
  }
  throw err;
}

async function init() {
  try {
    S.index = await getJson("data/index.json");
  } catch {
    $("#profile").innerHTML = `<div class="empty-state">Pas encore de données. Lancez le workflow « Collecte Buckler » dans l'onglet Actions du dépôt GitHub.</div>`;
    return;
  }
  document.title = S.index.title || "SF6 Tracker";
  $("#site-title").textContent = (S.index.title || "SF6 Tracker").replace(/^SF6\s*/i, "") || "Tracker";
  if (S.index.updated_at) $("#updated").textContent = "Mis à jour " + new Date(S.index.updated_at).toLocaleString("fr-FR");
  if (S.index.repo) {
    const a = $("#rv-edit");
    a.href = `https://github.com/${S.index.repo}/edit/main/config.json`;
    a.hidden = false;
  }
  $("#players").innerHTML = S.index.players
    .map((p) => `<button data-sid="${esc(p.sid)}">${esc(p.display || p.name)}</button>`)
    .join("");
  $("#players").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sid]");
    if (b) { location.hash = b.dataset.sid; }
  });
  bindControls();
  window.addEventListener("hashchange", loadPlayerFromHash);
  await loadPlayerFromHash();
}

async function loadPlayerFromHash() {
  const sids = S.index.players.map((p) => p.sid);
  const sid = sids.includes(location.hash.slice(1)) ? location.hash.slice(1) : sids[0];
  if (!sid) return;
  S.sid = sid;
  $$("#players button").forEach((b) => b.classList.toggle("active", b.dataset.sid === sid));
  try {
    S.data = await getJson(`data/players/${sid}.json`);
  } catch {
    S.data = { profile: { chars: {} }, matches: [] };
  }
  S.histLimit = 100;
  S.rival = null;
  setupCharSelects();
  renderProfile();
  showTab(S.tab);
}

// ------------------------------------------------------------------ rivaux
function rivalList() {
  const server = (S.index.rivals || []).map((r) => ({ sid: String(r.sid), name: r.name, src: "serveur" }));
  const local = store.get("localRivals", []).filter((r) => !server.some((s) => s.sid === r.sid));
  return [...server, ...local.map((r) => ({ ...r, src: "local" }))];
}
const rivalSids = () => new Set(rivalList().map((r) => r.sid));

// ------------------------------------------------------------------ profil
function playerSummary() { return S.index.players.find((p) => p.sid === S.sid) || {}; }

function renderProfile() {
  const p = S.data.profile || {};
  const sum = playerSummary();
  const m = S.data.matches;
  const main = p.main || m[0]?.me.char;
  const ci = (p.chars || {})[main] || {};
  const w = m.filter((x) => x.result === "W").length;
  const l24 = sum.last24h || { w: 0, l: 0, n: 0 };
  const name = sum.display || p.name || S.sid;
  $("#profile").innerHTML = `
    <div class="card name"><div class="k">Joueur</div><div class="v"><a href="${BUCKLER}${esc(S.sid)}" target="_blank" rel="noopener">${esc(name)}</a></div><div class="s">${esc(p.name && p.name !== name ? p.name + " · " : "")}CFN ${esc(S.sid)}</div></div>
    <div class="card"><div class="k">Perso principal</div><div class="v">${esc(main || "—")}</div><div class="s">${esc(leagueName(ci.rank))}</div></div>
    <div class="card"><div class="k">Master Rating</div><div class="v">${ci.mr ?? "—"}</div><div class="s">${esc(main || "")}</div></div>
    <div class="card"><div class="k">Dernières 24 h</div><div class="v"><span class="up">${l24.w}V</span> - <span class="down">${l24.l}D</span></div><div class="s">${l24.n} match(s)</div></div>
    <div class="card"><div class="k">Winrate enregistré</div><div class="v">${pct(w, m.length)}%</div><div class="s">${m.length} match(s)</div></div>`;
}

// ------------------------------------------------------------------ onglets
function showTab(tab) {
  S.tab = tab;
  store.set("tab", tab);
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  for (const t of ["progress", "history", "rivals"]) $(`#tab-${t}`).hidden = t !== tab;
  if (tab === "progress") renderProgress();
  if (tab === "history") renderHistory();
  if (tab === "rivals") renderRivals();
}

function charsPlayed() {
  const count = {};
  for (const m of S.data.matches) count[m.me.char] = (count[m.me.char] || 0) + 1;
  return Object.keys(count).sort((a, b) => count[b] - count[a]);
}

function setupCharSelects() {
  const chars = charsPlayed();
  const main = S.data.profile?.main && chars.includes(S.data.profile.main) ? S.data.profile.main : chars[0];
  $("#pg-char").innerHTML = chars.map((c) => `<option ${c === main ? "selected" : ""}>${esc(c)}</option>`).join("");
  $("#hi-char").innerHTML = `<option value="">Tous</option>` + chars.map((c) => `<option>${esc(c)}</option>`).join("");
  const opps = {};
  for (const m of S.data.matches) {
    const o = (opps[m.opp.sid] ||= { name: m.opp.name, n: 0 });
    o.n++;
  }
  $("#opp-list").innerHTML = Object.entries(opps)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 500)
    .map(([sid, o]) => `<option value="${esc(o.name)} (${esc(sid)})">${o.n} match(s)</option>`)
    .join("");
  S.metric = null;
}

function bindControls() {
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  // Progression
  $("#pg-char").addEventListener("change", () => { S.metric = null; renderProgress(); });
  $("#pg-start").addEventListener("change", renderProgress);
  $("#pg-end").addEventListener("change", renderProgress);
  $("#pg-quick").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const days = +b.dataset.days;
    $("#pg-end").value = "";
    $("#pg-start").value = days ? fmtDay(new Date(Date.now() - days * 86400000)) : "";
    renderProgress();
  });
  // Historique
  for (const id of ["#hi-char", "#hi-mode", "#hi-rivals"]) $(id).addEventListener("change", () => { S.histLimit = 100; renderHistory(); });
  $("#hi-search").addEventListener("input", () => { S.histLimit = 100; renderHistory(); });
  $("#hi-more").addEventListener("click", () => { S.histLimit += 200; renderHistory(); });
  $("#hi-body").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-opp]"); if (!a) return;
    e.preventDefault();
    S.rival = a.dataset.opp;
    showTab("rivals");
  });
  // Rivaux
  $("#rv-add").addEventListener("change", (e) => {
    const v = e.target.value.trim(); if (!v) return;
    const idm = v.match(/\((\d+)\)\s*$/) || v.match(/^(\d{6,})$/);
    let sid = idm?.[1];
    let name;
    if (!sid) {
      const m = S.data.matches.find((x) => x.opp.name.toLowerCase() === v.toLowerCase());
      if (m) { sid = m.opp.sid; name = m.opp.name; }
    }
    if (!sid) { alertInline("Adversaire introuvable dans l'historique."); return; }
    name ||= S.data.matches.find((x) => x.opp.sid === sid)?.opp.name || sid;
    const local = store.get("localRivals", []);
    if (!local.some((r) => r.sid === sid) && !rivalSids().has(sid)) local.push({ sid, name });
    store.set("localRivals", local);
    e.target.value = "";
    S.rival = sid;
    renderRivals();
  });
  $("#rv-grid").addEventListener("click", (e) => {
    const x = e.target.closest(".x");
    if (x) {
      e.stopPropagation();
      store.set("localRivals", store.get("localRivals", []).filter((r) => r.sid !== x.dataset.sid));
      if (S.rival === x.dataset.sid) S.rival = null;
      renderRivals();
      return;
    }
    const c = e.target.closest(".rv"); if (!c) return;
    S.rival = c.dataset.sid; renderRivals();
  });
  $("#rv-detail").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-opp]"); if (!a) return;
    e.preventDefault(); S.rival = a.dataset.opp; renderRivals();
  });
}

function alertInline(msg) {
  $("#rv-detail").innerHTML = `<div class="empty-state">${esc(msg)}</div>`;
}

// ------------------------------------------------------------------ progression
function renderProgress() {
  const char = $("#pg-char").value;
  const cur = (S.data.profile?.chars || {})[char] || {};
  const ranked = S.data.matches.filter((m) => m.mode === "Ranked" && m.me.char === char).slice().reverse();
  const key = "mr";
  const start = $("#pg-start").value ? new Date($("#pg-start").value + "T00:00:00").getTime() / 1000 : -Infinity;
  const end = $("#pg-end").value ? new Date($("#pg-end").value + "T23:59:59").getTime() / 1000 : Infinity;

  // chaque match = valeur AVANT le match ; on ajoute la valeur actuelle à la fin
  let pts = ranked.filter((m) => m.me[key] != null).map((m) => ({ t: m.t, v: m.me[key], m }));
  const last = ranked[ranked.length - 1];
  if (last && cur[key] != null && last.me[key] != null) pts.push({ t: Math.max(last.t + 60, Math.min(Date.now() / 1000, last.t + 600)), v: cur[key], current: true });
  pts = pts.filter((p) => p.t >= start && p.t <= end);
  drawChart(pts, key);

  const inRange = ranked.filter((m) => m.t >= start && m.t <= end);
  const w = inRange.filter((m) => m.result === "W").length;
  const l = inRange.filter((m) => m.result === "L").length;
  const delta = pts.length > 1 ? pts[pts.length - 1].v - pts[0].v : 0;
  const vals = pts.map((p) => p.v);
  $("#pg-stats").innerHTML = `
    <div class="card"><div class="k">Matchs classés</div><div class="v">${inRange.length}</div><div class="s"><span class="up">${w}V</span> · <span class="down">${l}D</span> · ${pct(w, inRange.length)}%</div></div>
    <div class="card"><div class="k">Variation ${key.toUpperCase()}</div><div class="v ${delta > 0 ? "up" : delta < 0 ? "down" : ""}">${delta > 0 ? "+" : ""}${delta.toLocaleString("fr-FR")}</div><div class="s">sur la période</div></div>
    <div class="card"><div class="k">Max ${key.toUpperCase()}</div><div class="v">${vals.length ? Math.max(...vals).toLocaleString("fr-FR") : "—"}</div><div class="s">sur la période</div></div>
    <div class="card"><div class="k">Min ${key.toUpperCase()}</div><div class="v">${vals.length ? Math.min(...vals).toLocaleString("fr-FR") : "—"}</div><div class="s">sur la période</div></div>`;
}

// Rangs Master (seuils MR officiels : 1500 / 1600 / 1700 / 1800 / Legend 2000). Couleurs approximatives : à ajuster ici.
const MR_TIERS = [
  { min: 1500, name: "Master", color: "#8b5cf6" },
  { min: 1600, name: "High Master", color: "#ec4899" },
  { min: 1700, name: "Grand Master", color: "#f97316" },
  { min: 1800, name: "Ultimate Master", color: "#eab308" },
  { min: 2000, name: "Legend", color: "#22d3ee" },
];

function drawChart(pts, key) {
  const svg = $("#chart");
  const W = svg.clientWidth || 800, H = svg.clientHeight || 360;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const tip = $("#tip");
  tip.hidden = true;
  if (pts.length < 2) {
    svg.innerHTML = `<text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">Pas assez de matchs Master classés sur cette période (le MR n'existe qu'en Master).</text>`;
    svg.onmousemove = null;
    return;
  }
  const pad = { l: 52, r: 16, t: 14, b: 28 };
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  // échelle MR : plancher fixe à 1500, graduations tous les 100 (toujours 1500-1800 visibles), aucun plafond
  const v0 = 1500;
  const v1 = Math.max(1900, Math.ceil((Math.max(...pts.map((p) => p.v)) + 1) / 100) * 100);
  // abscisse par index (comme un graphe de progression match par match) -> lisible même avec des pauses
  const n = pts.length;
  const x = (i) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (Math.max(v, v0) - v0) / (v1 - v0)) * (H - pad.t - pad.b);
  const color = "var(--text)";
  let g = "";
  // fond : couleurs des rangs Master (approximatives, modifiables dans MR_TIERS)
  MR_TIERS.forEach((t, i) => {
    const top = Math.min(v1, i + 1 < MR_TIERS.length ? MR_TIERS[i + 1].min : v1), bot = Math.max(v0, t.min);
    if (top <= bot) return;
    g += `<rect x="${pad.l}" y="${y(top)}" width="${W - pad.l - pad.r}" height="${y(bot) - y(top)}" fill="${t.color}" opacity=".14"/>` +
         `<text x="${W - pad.r - 6}" y="${y(top) + 14}" text-anchor="end" font-size="11" font-weight="700" fill="${t.color}">${t.name}</text>`;
  });
  for (let v = v0; v <= v1; v += 100) {
    g += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${v.toLocaleString("fr-FR")}</text>`;
  }
  const ticks = Math.min(6, n);
  for (let k = 0; k < ticks; k++) {
    const i = Math.round((k * (n - 1)) / (ticks - 1 || 1));
    const short = t1 - t0 < 3 * 86400;
    const d = new Date(pts[i].t * 1000).toLocaleString("fr-FR", short ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "2-digit", year: "2-digit" });
    g += `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="${k === 0 ? "start" : k === ticks - 1 ? "end" : "middle"}">${d}</text>`;
  }
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = `${path}L${x(n - 1)},${H - pad.b}L${x(0)},${H - pad.b}Z`;
  const rs = rivalSids();
  const dots = n <= 250
    ? pts.map((p, i) => {
        const c = p.current ? color : p.m.result === "W" ? "var(--win)" : p.m.result === "L" ? "var(--loss)" : "var(--draw)";
        const ring = p.m && rs.has(p.m.opp.sid) ? ` stroke="var(--rival)" stroke-width="2"` : "";
        return `<circle cx="${x(i)}" cy="${y(p.v)}" r="${p.current ? 4.5 : 3}" fill="${c}"${ring}/>`;
      }).join("")
    : "";
  svg.innerHTML = `${g}<path d="${area}" fill="${color}" opacity=".05"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>${dots}<line id="cross" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--muted)" stroke-dasharray="3 3" opacity="0"/>`;
  svg.onmousemove = (e) => {
    const r = svg.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((mx - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
    const p = pts[i];
    const cross = svg.querySelector("#cross");
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("opacity", 1);
    tip.hidden = false;
    tip.innerHTML = p.current
      ? `<b>${p.v.toLocaleString("fr-FR")}</b> ${key.toUpperCase()}<br><span class="muted">Valeur actuelle</span>`
      : `<b>${p.v.toLocaleString("fr-FR")}</b> ${key.toUpperCase()} <span class="badge ${p.m.result}">${p.m.result === "W" ? "V" : p.m.result === "L" ? "D" : "N"}</span><br>vs ${esc(p.m.opp.name)} (${esc(p.m.opp.char)})${rs.has(p.m.opp.sid) ? '<span class="tag">RIVAL</span>' : ""}<br><span class="muted">${fmtDate(p.m.t)}</span>`;
    const left = (x(i) / W) * r.width;
    tip.style.left = Math.min(Math.max(8, left + 12), r.width - tip.offsetWidth - 8) + "px";
    tip.style.top = Math.max(8, (y(p.v) / H) * r.height - 20) + "px";
  };
  svg.onmouseleave = () => { tip.hidden = true; svg.querySelector("#cross")?.setAttribute("opacity", 0); };
}
window.addEventListener("resize", () => { if (S.tab === "progress" && S.data) renderProgress(); });

// ------------------------------------------------------------------ historique
function ratingCell(m) {
  const d = m.me.mrDelta;
  const after = m.me.mrAfter ?? m.me.mr;
  if (after == null) return `<span class="muted">—</span>`;
  const ds = d == null ? "" : ` <span class="${d > 0 ? "up" : d < 0 ? "down" : "muted"}">${d > 0 ? "+" : ""}${d}</span>`;
  return `${after.toLocaleString("fr-FR")} <span class="muted">MR</span>${ds}`;
}

function rowHtml(m, rs) {
  const isRival = rs.has(m.opp.sid);
  const label = { W: "V", L: "D", D: "N" }[m.result];
  return `<tr class="${isRival ? "rival" : ""}">
    <td>${fmtDate(m.t)}</td>
    <td><span class="badge ${m.result}">${label}</span></td>
    <td>${esc(m.me.char)}${m.me.input ? ` <span class="muted">${esc(m.me.input)}</span>` : ""}</td>
    <td><a href="#" data-opp="${esc(m.opp.sid)}" title="Voir le face-à-face">${esc(m.opp.name)}</a>${isRival ? '<span class="tag">RIVAL</span>' : ""} <span class="muted">${esc(m.opp.char)}${m.opp.mr ? " · " + m.opp.mr + " MR" : ""}</span>
      <a href="${BUCKLER}${esc(m.opp.sid)}" target="_blank" rel="noopener" class="muted" title="Profil Buckler">↗</a></td>
    <td>${m.score[0]} - ${m.score[1]}</td>
    <td class="muted">${esc(m.mode)}</td>
    <td class="num">${m.mode === "Ranked" ? ratingCell(m) : '<span class="muted">—</span>'}</td>
  </tr>`;
}

function renderHistory() {
  const char = $("#hi-char").value, mode = $("#hi-mode").value;
  const q = $("#hi-search").value.trim().toLowerCase();
  const onlyRivals = $("#hi-rivals").checked;
  const rs = rivalSids();
  const list = S.data.matches.filter((m) =>
    (!char || m.me.char === char) && (!mode || m.mode === mode) &&
    (!q || m.opp.name.toLowerCase().includes(q) || m.opp.sid === q) &&
    (!onlyRivals || rs.has(m.opp.sid)));
  $("#hi-body").innerHTML = list.length
    ? list.slice(0, S.histLimit).map((m) => rowHtml(m, rs)).join("")
    : `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">Aucun match.</td></tr>`;
  $("#hi-more").hidden = list.length <= S.histLimit;
}

// ------------------------------------------------------------------ rivaux
function h2h(sid) {
  const list = S.data.matches.filter((m) => m.opp.sid === sid);
  const w = list.filter((m) => m.result === "W").length, l = list.filter((m) => m.result === "L").length;
  return { list, w, l, n: list.length };
}

function renderRivals() {
  const rivals = rivalList();
  // un adversaire consulté depuis l'historique sans être rival apparaît aussi
  const extra = S.rival && !rivals.some((r) => r.sid === S.rival)
    ? [{ sid: S.rival, name: S.data.matches.find((m) => m.opp.sid === S.rival)?.opp.name || S.rival, src: "consulté" }]
    : [];
  const all = [...rivals, ...extra];
  $("#rv-grid").innerHTML = all.length
    ? all.map((r) => {
        const h = h2h(r.sid);
        const name = h.list[0]?.opp.name || r.name;
        return `<div class="rv ${S.rival === r.sid ? "active" : ""}" data-sid="${esc(r.sid)}" role="button" tabindex="0">
          ${r.src === "local" ? `<button class="x" data-sid="${esc(r.sid)}" title="Retirer">×</button>` : ""}
          <h3>${esc(name)}</h3>
          <div class="src">${r.src === "serveur" ? "Rival (alertes Discord)" : r.src === "local" ? "Ajouté sur ce navigateur" : "Adversaire consulté"} · CFN ${esc(r.sid)}</div>
          <div class="rec"><span class="w">${h.w}</span> - <span class="l">${h.l}</span> <span class="muted" style="font-size:14px">${h.n ? pct(h.w, h.n) + "%" : "aucun match"}</span></div>
          <div class="bar"><i style="width:${h.n ? pct(h.w, h.w + h.l) : 0}%"></i></div>
          <div class="dots">${h.list.slice(0, 10).map((m) => `<span class="${m.result}">${{ W: "V", L: "D", D: "N" }[m.result]}</span>`).join("")}</div>
        </div>`;
      }).join("")
    : `<div class="empty-state">Aucun rival. Ajoutez-en dans config.json (alertes Discord) ou avec le champ ci-dessus (sur ce navigateur uniquement).</div>`;

  const det = $("#rv-detail");
  if (!S.rival) { det.innerHTML = ""; return; }
  const h = h2h(S.rival);
  const name = h.list[0]?.opp.name || all.find((r) => r.sid === S.rival)?.name || S.rival;
  if (!h.n) { det.innerHTML = `<h2>Face-à-face contre ${esc(name)}</h2><div class="empty-state">Aucun match enregistré contre cet adversaire.</div>`; return; }
  const byChar = (get) => {
    const o = {};
    for (const m of h.list) { const k = get(m); (o[k] ||= { w: 0, n: 0 }); o[k].n++; if (m.result === "W") o[k].w++; }
    return Object.entries(o).sort((a, b) => b[1].n - a[1].n);
  };
  const rs = rivalSids();
  det.innerHTML = `
    <h2>Face-à-face contre <a href="${BUCKLER}${esc(S.rival)}" target="_blank" rel="noopener" style="color:inherit">${esc(name)} ↗</a></h2>
    <div class="chips">
      <span class="chip"><b>${h.w}V - ${h.l}D</b> · ${pct(h.w, h.n)}%</span>
      <span class="chip">Premier match : ${fmtDate(h.list[h.list.length - 1].t)}</span>
      <span class="chip">Dernier : ${fmtDate(h.list[0].t)}</span>
    </div>
    <div class="chips">${byChar((m) => m.opp.char).map(([c, s]) => `<span class="chip">Contre ${esc(c)} : ${s.w}/${s.n} (${pct(s.w, s.n)}%)</span>`).join("")}</div>
    <div class="chips">${byChar((m) => m.me.char).map(([c, s]) => `<span class="chip">Avec ${esc(c)} : ${s.w}/${s.n} (${pct(s.w, s.n)}%)</span>`).join("")}</div>
    <div class="table-wrap"><table class="matches">
      <thead><tr><th>Date</th><th>Rés.</th><th>Perso</th><th>Adversaire</th><th>Score</th><th>Mode</th><th class="num">MR</th></tr></thead>
      <tbody>${h.list.slice(0, 300).map((m) => rowHtml(m, rs)).join("")}</tbody>
    </table></div>`;
}

init();
