#!/usr/bin/env python3
"""Vérifie une fois le battle log Buckler (SF6) de chaque joueur, alerte sur Discord
et met à jour history.json. Conçu pour tourner via GitHub Actions.
Secrets lus dans l'environnement : DISCORD_WEBHOOK, BUCKLER_COOKIE.
NON TESTÉ contre le vrai site : la structure JSON de Capcom peut changer."""
import json, os, re, time, urllib.request, urllib.error
from pathlib import Path

CFG = json.loads(Path("config.json").read_text())
WEBHOOK = os.environ["DISCORD_WEBHOOK"]
COOKIE = os.environ["BUCKLER_COOKIE"]
HIST, SEEN = Path("history.json"), Path("seen.json")
BASE = "https://www.streetfighter.com/6/buckler"
UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.streetfighter.com/6/buckler",
    "Cookie": COOKIE.strip(),
}

def get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
            return r.read().decode()
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="ignore")[:300].replace("\n", " ")
        raise RuntimeError(f"HTTP {e.code} | server={e.headers.get('server')} | {body}")

def battlelog(sid, pages=1):
    """Récupère jusqu'à `pages` pages (10 matchs/page, Capcom garde ~100 matchs max)."""
    html = get(f"{BASE}/en/profile/{sid}/battlelog")
    build = re.search(r'"buildId":"([^"]+)"', html).group(1)
    out = []
    for p in range(1, pages + 1):
        data = get(f"{BASE}/_next/data/{build}/en/profile/{sid}/battlelog.json?page={p}&sid={sid}")
        page = json.loads(data)["pageProps"].get("replay_list", [])
        out += page
        if len(page) < 10:
            break
        time.sleep(1)
    return out

def side(rep, sid):
    p1, p2 = rep["player1_info"], rep["player2_info"]
    return (p1, p2) if str(p1["player"]["short_id"]) == str(sid) else (p2, p1)

def discord(text, embed=None):
    body = {"content": text}
    if embed: body["embeds"] = [embed]
    req = urllib.request.Request(WEBHOOK, json.dumps(body).encode(),
                                 {"Content-Type": "application/json", "User-Agent": "sf6-tracker"})
    urllib.request.urlopen(req, timeout=15)

def load(p, default):
    return json.loads(p.read_text()) if p.exists() else default

seen, hist = load(SEEN, {}), load(HIST, {})
for pl in CFG["players"]:
    name, sid = pl["name"], pl["sid"]
    first = sid not in seen            # première fois : on récupère tout l'historique, sans alerter
    try:
        reps = battlelog(sid, pages=10 if first else 1)
    except Exception as e:
        print(f"[{name}] erreur : {e}")
        continue
    known = set(seen.get(sid, []))
    for r in reversed([r for r in reps if r["replay_id"] not in known]):
        me, opp = side(r, sid)
        lp, mr = me.get("league_point"), me.get("master_rating")
        hist.setdefault(name, []).append({"t": r.get("uploaded_at", int(time.time())), "lp": lp, "mr": mr})
        if not first:
            discord(f"🎮 **{name}** vient de lancer un match !", {
                "title": f"{name} vs {opp['player']['fighter_id']}",
                "description": f"{me.get('character_name','?')} vs {opp.get('character_name','?')}",
                "fields": [{"name": "LP", "value": str(lp), "inline": True},
                           {"name": "MR", "value": str(mr), "inline": True}],
                "url": f"{BASE}/en/profile/{sid}/battlelog"})
    seen[sid] = [r["replay_id"] for r in reps]
    print(f"[{name}] {len(reps)} matchs dans le log")

for k in hist:
    hist[k].sort(key=lambda d: d["t"])
HIST.write_text(json.dumps(hist)); SEEN.write_text(json.dumps(seen))
