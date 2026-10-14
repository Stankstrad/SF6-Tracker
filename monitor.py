#!/usr/bin/env python3
"""Collecte le battle log Buckler (SF6), alerte sur Discord et écrit data/ pour le site.
Secrets (variables d'environnement) : DISCORD_WEBHOOK, BUCKLER_COOKIE.
Lit config.json (players, rivals, alerts, max_pages, max_matches_stored, site_title)."""
import json, os, re, subprocess, time, urllib.request, urllib.error
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://www.streetfighter.com/6/buckler"
DATA, PL = Path("data"), Path("data/players")
BACKFILL = {"on": os.environ.get("BACKFILL") == "1"}  # désactivé après le 1er passage
LEAGUES = ["Rookie", "Iron", "Bronze", "Silver", "Gold", "Platinum", "Diamond"]


def headers():
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": BASE,
        "Cookie": os.environ.get("BUCKLER_COOKIE", "").strip(),
    }


def get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers()), timeout=20) as r:
            return r.read().decode()
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="ignore")[:300].replace("\n", " ")
        raise RuntimeError(f"HTTP {e.code} | server={e.headers.get('server')} | {body}")


def battlelog(sid, pages=1, known=None):
    """Lit jusqu'à `pages` pages ; s'arrête dès qu'une page contient un match déjà connu
    (comble ainsi les trous après une panne, sans requêtes inutiles en temps normal)."""
    html = get(f"{BASE}/en/profile/{sid}/battlelog")
    build = re.search(r'"buildId":"([^"]+)"', html).group(1)
    out = []
    for p in range(1, pages + 1):
        data = get(f"{BASE}/_next/data/{build}/en/profile/{sid}/battlelog.json?page={p}&sid={sid}")
        page = json.loads(data)["pageProps"].get("replay_list", [])
        out += page
        if len(page) < 10 or (known and any(str(r.get("replay_id")) in known for r in page)):
            break
        time.sleep(1)
    return out


def discord(text, embed=None):
    hook = os.environ.get("DISCORD_WEBHOOK")
    if not hook:
        print("(pas de DISCORD_WEBHOOK, alerte ignorée)")
        return
    body = {"content": text}
    if embed:
        body["embeds"] = [embed]
    req = urllib.request.Request(hook, json.dumps(body).encode(),
                                 {"Content-Type": "application/json", "User-Agent": "sf6-tracker"})
    urllib.request.urlopen(req, timeout=15)


# ------------------------------------------------------------------ conversion
def pos(x):
    return x if isinstance(x, (int, float)) and x > 0 else None


def mode_of(r):
    n = (r.get("replay_battle_type_name") or "").lower()
    for key, label in (("ranked", "Ranked"), ("casual", "Casual"), ("hub", "Hub"), ("room", "Room"), ("custom", "Room")):
        if key in n:
            return label
    return r.get("replay_battle_type_name") or "Casual"


def rounds_won(info):
    return sum(1 for x in (info.get("round_results") or []) if x)


def my_name(r, sid):
    p1, p2 = r["player1_info"]["player"], r["player2_info"]["player"]
    return (p1 if str(p1["short_id"]) == str(sid) else p2).get("fighter_id")


def parse(r, sid):
    p1, p2 = r["player1_info"], r["player2_info"]
    me, opp = (p1, p2) if str(p1["player"]["short_id"]) == str(sid) else (p2, p1)
    a, b = rounds_won(me), rounds_won(opp)
    return {
        "id": str(r["replay_id"]),
        "t": r.get("uploaded_at") or int(time.time()),
        "mode": mode_of(r),
        "result": "W" if a > b else "L" if b > a else "D",
        "score": [a, b],
        "me": {"char": me.get("character_name") or "?",
               "input": me.get("input_type_name") or me.get("battle_input_type_name") or "",
               "lp": pos(me.get("league_point")), "mr": pos(me.get("master_rating")),
               "rank": me.get("league_rank")},
        "opp": {"sid": str(opp["player"]["short_id"]), "name": opp["player"].get("fighter_id") or "?",
                "char": opp.get("character_name") or "?",
                "lp": pos(opp.get("league_point")), "mr": pos(opp.get("master_rating"))},
    }


def enrich(matches):
    """Les valeurs du battle log sont celles AVANT le match : la valeur « après » = valeur avant
    du match classé suivant avec le même personnage."""
    nxt = {}
    for m in sorted(matches, key=lambda x: x["t"], reverse=True):
        if m["mode"] != "Ranked":
            continue
        c = m["me"]["char"]
        n = nxt.get(c)
        for k in ("lp", "mr"):
            cur, after = m["me"].get(k), (n["me"].get(k) if n else None)
            if cur is not None and after is not None:
                m["me"][k + "After"], m["me"][k + "Delta"] = after, after - cur
            else:
                m["me"].pop(k + "After", None)
                m["me"].pop(k + "Delta", None)
        nxt[c] = m


def make_profile(matches, name):
    chars = {}
    for m in sorted(matches, key=lambda x: x["t"]):
        me = m["me"]
        if m["mode"] == "Ranked" and (me["lp"] is not None or me["mr"] is not None):
            chars[me["char"]] = {"rank": me.get("rank"), "lp": me["lp"], "mr": me["mr"]}
    return {"name": name, "main": matches[0]["me"]["char"] if matches else None, "chars": chars}


# ------------------------------------------------------------------ alertes
def alert_for(m, prev, name, sid, A, rival_sids):
    """Alerte seulement : (1) premier match classé après une pause d'au moins `ranked_gap_minutes`,
    ou (2) match contre un rival (tous modes). `prev` = match classé précédent du joueur (tous persos)."""
    reasons = []
    if m["mode"] == "Ranked" and (prev is None or m["t"] - prev["t"] >= A["ranked_gap_minutes"] * 60):
        reasons.append(f"🆕 Premier match classé (pas de ranked depuis {A['ranked_gap_minutes']} min ou plus)")
    is_rival = m["opp"]["sid"] in rival_sids
    if is_rival and A["rivals"]:
        reasons.append("⭐ Match contre un rival")
    if not reasons:
        return
    icon = {"W": "✅", "L": "❌", "D": "➖"}[m["result"]]
    fields = []
    if m["me"]["mr"] is not None:
        fields.append({"name": "MR (avant)", "value": str(m["me"]["mr"]), "inline": True})
    desc = f"{m['me']['char']} vs {m['opp']['char']} · {m['score'][0]}-{m['score'][1]} · {m['mode']}\n" + "\n".join(reasons)
    discord(f"{icon} **{name}** a joué un match",
            {"title": f"{name} vs {m['opp']['name']}", "description": desc, "fields": fields,
             "url": f"{BASE}/en/profile/{sid}/battlelog"})
    time.sleep(1)


# ------------------------------------------------------------------ principal
def dump(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


def main():
    C = json.loads(Path("config.json").read_text())
    A = {"rivals": True, "ranked_gap_minutes": 30, "max_alert_age_minutes": 20, **C.get("alerts", {})}
    max_pages, keep = C.get("max_pages", 10), C.get("max_matches_stored", 5000)
    rivals = [{"sid": str(r["sid"]), "name": r.get("name", "")} for r in C.get("rivals", [])]
    rival_sids = {r["sid"] for r in rivals}
    PL.mkdir(parents=True, exist_ok=True)
    index_players, now, errors = [], time.time(), 0

    for pl in C["players"]:
        name, sid = pl["name"], str(pl["sid"])
        f = PL / f"{sid}.json"
        old = json.loads(f.read_text()) if f.exists() else None
        stored = old["matches"] if old else []
        first = old is None
        known = {m["id"] for m in stored}
        try:
            # BACKFILL=1 : relit tout le battle log disponible (100 derniers matchs chez Buckler).
            reps = battlelog(sid, max_pages, None if (first or BACKFILL["on"]) else known)
        except Exception as e:
            print(f"[{name}] erreur : {e}")
            errors += 1
            reps = []
        new = []
        for r in reps:
            if str(r.get("replay_id")) in known:
                continue
            try:
                new.append(parse(r, sid))
            except Exception as e:
                print(f"[{name}] match ignoré ({type(e).__name__}: {e})")
        matches = stored
        if new:
            matches = sorted(new + stored, key=lambda x: x["t"], reverse=True)[:keep]
            enrich(matches)
            prof_name = my_name(reps[0], sid)
            dump(f, {"profile": make_profile(matches, prof_name or name), "matches": matches})
            if not first:
                ids = {m["id"] for m in new}
                fresh = [x for x in matches if x["id"] in ids and x["t"] >= now - A["max_alert_age_minutes"] * 60]
                for m in list(reversed(fresh))[-10:]:
                    i = matches.index(m)
                    prev = next((x for x in matches[i + 1:] if x["mode"] == "Ranked"), None)
                    try:
                        alert_for(m, prev, name, sid, A, rival_sids)
                    except Exception as e:
                        print(f"[{name}] alerte Discord échouée : {e}")
        # contrôle de cohérence (résultat déduit des rounds vs variation de LP)
        chk = [(m["me"]["lpDelta"] > 0) == (m["result"] == "W") for m in matches
               if m["mode"] == "Ranked" and m["me"].get("lpDelta")]
        if chk:
            print(f"[{name}] cohérence résultats/LP : {sum(chk)}/{len(chk)}")
        print(f"[{name}] {len(reps)} matchs lus, {len(new)} nouveaux, {len(matches)} stockés")
        day = [m for m in matches if m["t"] >= now - 86400]
        index_players.append({"sid": sid, "name": name, "display": name,
                              "last_t": matches[0]["t"] if matches else None,
                              "last24h": {"w": sum(m["result"] == "W" for m in day),
                                          "l": sum(m["result"] == "L" for m in day), "n": len(day)}})

    idx = {"title": C.get("site_title", "SF6 Tracker"), "repo": os.environ.get("GITHUB_REPOSITORY", ""),
           "players": index_players, "rivals": rivals}
    ip = DATA / "index.json"
    prev_idx = json.loads(ip.read_text()) if ip.exists() else {}
    if {k: v for k, v in prev_idx.items() if k != "updated_at"} != idx:
        dump(ip, {**idx, "updated_at": datetime.now(timezone.utc).isoformat()})
    return errors == len(C["players"])  # True = Buckler n'a répondu pour personne


def git_push():
    """Avec GIT_PUSH=1 (dans le workflow), publie data/ après chaque passage au lieu d'attendre la fin du job."""
    if os.environ.get("GIT_PUSH") != "1":
        return
    run = lambda *a: subprocess.run(["git", *a], capture_output=True, text=True)
    run("add", "-A", "data")
    if run("diff", "--cached", "--quiet").returncode == 0:
        return
    run("commit", "-q", "-m", "maj données")
    for _ in range(3):
        if run("pull", "--rebase", "-q").returncode == 0 and run("push", "-q").returncode == 0:
            print("données publiées")
            return
        run("rebase", "--abort")
        time.sleep(3)
    print("push échoué, nouvel essai au prochain passage")


if __name__ == "__main__":
    # LOOP_SECONDS > 0 : le script repasse toutes les POLL_SECONDS pendant cette durée (alertes plus rapides).
    # L'état est relu depuis data/ à chaque tour, donc aucune alerte en double.
    loop, poll = int(os.environ.get("LOOP_SECONDS", 0)), int(os.environ.get("POLL_SECONDS", 45))
    end = time.time() + loop
    while True:
        all_failed = main()
        BACKFILL["on"] = False
        git_push()
        if time.time() + poll >= end:
            break
        time.sleep(poll)
    if all_failed:
        # Fait passer le job en rouge dans Actions au lieu d'un faux « succès ».
        raise SystemExit("ÉCHEC : Buckler a refusé toutes les requêtes (cookie BUCKLER_COOKIE expiré ou accès bloqué).")
