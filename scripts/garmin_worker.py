#!/usr/bin/env python3
"""BhatBot Garmin worker — runs in ~/.bhatbot/garmin-venv (garminconnect 0.3.x, the same library the
eddmann garmin-connect-mcp wraps; 0.3 dropped the garth dep — tokens persist via client.dump/load).
Stateless: node (lib/garmin.js) spawns it with a JSON request on
argv[1] or stdin and reads one JSON object back on stdout. Credentials NEVER come from the model — node
reads them from the macOS Keychain and passes them only for the one-time `login`. After that the worker
just loads cached OAuth tokens from ~/.bhatbot/garmin/tokens, so no password is needed per pull.

Actions: login {email,password,mfa?} · status · daily {date?} · activities {limit?}

Every Garmin call is wrapped — the API surface varies by version + by what the watch has synced, so a
missing metric yields null (never a crash). We do not invent values.
"""
import sys, os, json, datetime

HOME = os.path.expanduser("~/.bhatbot")
TOKENS = os.path.join(HOME, "garmin", "tokens")


def _out(obj):
    sys.stdout.write(json.dumps(obj, default=str))
    sys.stdout.flush()
    sys.exit(0)


def _today(date):
    return date or datetime.date.today().isoformat()


def _client(req):
    """Return an authenticated Garmin client, or raise. Prefers cached tokens; falls back to the creds
    in `req` for a one-time login (with optional MFA resume)."""
    from garminconnect import Garmin
    os.makedirs(TOKENS, exist_ok=True)
    # 1) cached tokens (the normal path — no password needed)
    try:
        g = Garmin()
        g.login(TOKENS)
        return g
    except Exception:
        pass
    # 2) credentialed login (setup / token refresh)
    email, password = req.get("email"), req.get("password")
    if not email or not password:
        raise RuntimeError("not_authenticated")
    g = Garmin(email=email, password=password, return_on_mfa=True)
    res = g.login()
    # garminconnect >=0.3 returns ("needs_mfa", client_state) when MFA is required
    if isinstance(res, tuple) and res and res[0] == "needs_mfa":
        mfa = req.get("mfa")
        if not mfa:
            raise RuntimeError("mfa_required")
        g.resume_login(res[1], str(mfa))
    # Persist OAuth tokens. garminconnect 0.3.x replaced the garth backend; in return_on_mfa
    # mode login() short-circuits before its own auto-dump, so we always dump explicitly here.
    g.client.dump(TOKENS)
    return g


def _safe(fn, *a, **k):
    try:
        return fn(*a, **k)
    except Exception:
        return None


def _num(d, *keys):
    """Pull the first present numeric key from a dict."""
    if not isinstance(d, dict):
        return None
    for k in keys:
        v = d.get(k)
        if isinstance(v, (int, float)):
            return v
    return None


def daily(g, date):
    d = _today(date)
    stats = _safe(g.get_stats, d) or {}
    sleep = _safe(g.get_sleep_data, d) or {}
    hrv = _safe(g.get_hrv_data, d) or {}
    bb = _safe(g.get_body_battery, d) or []
    stress = _safe(g.get_stress_data, d) or {}
    rt = _safe(g.get_training_readiness, d) or {}
    spo2 = _safe(g.get_spo2_data, d) or {}
    vo2 = _safe(g.get_max_metrics, d) or []
    body = _safe(g.get_body_composition, d) or {}

    sleep_sum = (sleep.get("dailySleepDTO") or {}) if isinstance(sleep, dict) else {}
    bb_latest = None
    try:
        if isinstance(bb, list) and bb:
            arr = (bb[0] or {}).get("bodyBatteryValuesArray") or []
            if arr:
                bb_latest = arr[-1][1]
    except Exception:
        bb_latest = None
    rt0 = (rt[0] if isinstance(rt, list) and rt else rt) or {}
    vo20 = (vo2[0] if isinstance(vo2, list) and vo2 else vo2) or {}
    vo2_val = None
    try:
        gen = (vo20.get("generic") or {}) if isinstance(vo20, dict) else {}
        vo2_val = gen.get("vo2MaxPreciseValue") or gen.get("vo2MaxValue")
    except Exception:
        vo2_val = None

    return {
        "date": d,
        "resting_hr": _num(stats, "restingHeartRate"),
        "max_hr": _num(stats, "maxHeartRate"),
        "min_hr": _num(stats, "minHeartRate"),
        "steps": _num(stats, "totalSteps"),
        "step_goal": _num(stats, "dailyStepGoal"),
        "calories": _num(stats, "totalKilocalories"),
        "active_calories": _num(stats, "activeKilocalories"),
        "intensity_minutes": (_num(stats, "moderateIntensityMinutes") or 0) + (_num(stats, "vigorousIntensityMinutes") or 0) * 2,
        "floors_climbed": _num(stats, "floorsAscended"),
        "stress_avg": _num(stats, "averageStressLevel") or _num(stress, "avgStressLevel"),
        "body_battery": bb_latest if bb_latest is not None else (_num(stats, "bodyBatteryMostRecentValue")),
        "body_battery_high": _num(stats, "bodyBatteryHighestValue"),
        "body_battery_low": _num(stats, "bodyBatteryLowestValue"),
        "sleep_seconds": _num(sleep_sum, "sleepTimeSeconds"),
        "sleep_score": _num((sleep_sum.get("sleepScores") or {}).get("overall") or {} if isinstance(sleep_sum.get("sleepScores"), dict) else {}, "value"),
        "deep_sleep_seconds": _num(sleep_sum, "deepSleepSeconds"),
        "rem_sleep_seconds": _num(sleep_sum, "remSleepSeconds"),
        "hrv_avg": _num((hrv.get("hrvSummary") or {}) if isinstance(hrv, dict) else {}, "lastNightAvg", "weeklyAvg"),
        "hrv_status": ((hrv.get("hrvSummary") or {}).get("status") if isinstance(hrv, dict) else None),
        "spo2_avg": _num(spo2, "averageSpO2", "avgSpO2"),
        "respiration_avg": _num(stats, "avgWakingRespirationValue"),
        "training_readiness": _num(rt0, "score"),
        "training_readiness_label": rt0.get("level") if isinstance(rt0, dict) else None,
        "vo2max": vo2_val,
        "weight_g": _num(body, "weight"),
        "bmi": _num(body, "bmi"),
        "body_fat_pct": _num(body, "bodyFat"),
    }


def main():
    raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    try:
        req = json.loads(raw or "{}")
    except Exception:
        _out({"ok": False, "error": "bad request json"})
    action = req.get("action", "status")
    try:
        if action == "login":
            g = _client(req)  # forces a credentialed login + token dump
            who = _safe(g.get_full_name) or _safe(g.get_unit_system) or "ok"
            _out({"ok": True, "logged_in": True, "who": who})
        g = _client(req)
        if action == "status":
            _out({"ok": True, "authenticated": True, "name": _safe(g.get_full_name)})
        elif action == "daily":
            _out({"ok": True, "daily": daily(g, req.get("date"))})
        elif action == "activities":
            acts = _safe(g.get_activities, 0, int(req.get("limit", 5))) or []
            slim = [{
                "name": a.get("activityName"),
                "type": (a.get("activityType") or {}).get("typeKey"),
                "start": a.get("startTimeLocal"),
                "duration_s": a.get("duration"),
                "distance_m": a.get("distance"),
                "calories": a.get("calories"),
                "avg_hr": a.get("averageHR"),
                "training_effect": a.get("aerobicTrainingEffect"),
            } for a in acts]
            _out({"ok": True, "activities": slim})
        else:
            _out({"ok": False, "error": "unknown action: " + str(action)})
    except RuntimeError as e:
        _out({"ok": False, "error": str(e)})
    except Exception as e:
        _out({"ok": False, "error": type(e).__name__ + ": " + str(e)[:200]})


if __name__ == "__main__":
    main()
