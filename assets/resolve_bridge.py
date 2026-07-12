#!/usr/bin/env python3
"""DaVinci Resolve bridge for BhatBot.

Reads one JSON command from argv[1] (or stdin), talks to a RUNNING DaVinci Resolve
via the installed DaVinciResolveScript module, and prints a JSON result on stdout.
Never raises to the caller — every failure is returned as {"error": "..."}.

Resolve must be running with External Scripting enabled
(Preferences > System > General > External scripting using = Local/Network).
"""
import sys, os, json

def _load():
    # Standard install locations for the scripting module + shared lib.
    api = os.environ.get("RESOLVE_SCRIPT_API",
        "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting")
    mod = os.path.join(api, "Modules")
    if mod not in sys.path:
        sys.path.append(mod)
    # Only pin the shared lib if the caller hasn't and a known copy actually exists — a bogus
    # RESOLVE_SCRIPT_LIB breaks scriptapp(), while leaving it unset lets the module self-locate.
    if not os.environ.get("RESOLVE_SCRIPT_LIB"):
        for lib in ("/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so",
                    "/Applications/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so"):
            if os.path.exists(lib):
                os.environ["RESOLVE_SCRIPT_LIB"] = lib
                break
    import DaVinciResolveScript as dvr  # noqa
    return dvr

def main():
    try:
        raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
        cmd = json.loads(raw or "{}")
    except Exception as e:
        return {"error": "bad command json: %s" % e}
    action = (cmd.get("action") or "status").strip()
    p = cmd.get("params") or {}

    try:
        dvr = _load()
    except Exception as e:
        return {"error": "DaVinci Resolve scripting module not available: %s" % e}

    resolve = dvr.scriptapp("Resolve")
    if resolve is None:
        return {"error": "DaVinci Resolve is not running (or External Scripting is disabled in Preferences > System > General). Open Resolve and enable it, then try again."}

    pm = resolve.GetProjectManager()
    proj = pm.GetCurrentProject() if pm else None

    def timeline_info(tl):
        if not tl:
            return None
        return {
            "name": tl.GetName(),
            "start_frame": tl.GetStartFrame(),
            "end_frame": tl.GetEndFrame(),
            "video_tracks": tl.GetTrackCount("video"),
            "audio_tracks": tl.GetTrackCount("audio"),
            "markers": len(tl.GetMarkers() or {}),
        }

    try:
        if action == "status":
            return {"ok": True, "page": resolve.GetCurrentPage(),
                    "product": resolve.GetProductName(), "version": resolve.GetVersionString(),
                    "project": proj.GetName() if proj else None}

        if action == "list_projects":
            return {"ok": True, "projects": list(pm.GetProjectListInCurrentFolder() or [])}

        if action == "open_project":
            name = p.get("name")
            if not name:
                return {"error": "open_project needs params.name"}
            ok = pm.LoadProject(name)
            return {"ok": bool(ok), "project": name} if ok else {"error": "could not open project '%s'" % name}

        if action == "project_info":
            if not proj:
                return {"error": "no project open"}
            tl = proj.GetCurrentTimeline()
            return {"ok": True, "name": proj.GetName(),
                    "timeline_count": proj.GetTimelineCount(),
                    "current_timeline": timeline_info(tl)}

        if action == "list_timelines":
            if not proj:
                return {"error": "no project open"}
            n = proj.GetTimelineCount()
            tls = [proj.GetTimelineByIndex(i + 1).GetName() for i in range(n)]
            return {"ok": True, "timelines": tls}

        if action == "timeline_info":
            if not proj:
                return {"error": "no project open"}
            return {"ok": True, "timeline": timeline_info(proj.GetCurrentTimeline())}

        if action == "switch_page":
            page = (p.get("page") or "edit").lower()
            ok = resolve.OpenPage(page)
            return {"ok": bool(ok), "page": page}

        if action == "add_marker":
            if not proj:
                return {"error": "no project open"}
            tl = proj.GetCurrentTimeline()
            if not tl:
                return {"error": "no current timeline"}
            frame = int(p.get("frame", tl.GetCurrentFrame() if hasattr(tl, "GetCurrentFrame") else tl.GetStartFrame()))
            ok = tl.AddMarker(frame, p.get("color", "Blue"), p.get("name", "BhatBot"),
                              p.get("note", ""), 1, "")
            return {"ok": bool(ok), "frame": frame}

        if action == "render":
            if not proj:
                return {"error": "no project open"}
            proj.AddRenderJob()
            proj.StartRendering()
            return {"ok": True, "note": "render started for the queued job(s)"}

        return {"error": "unknown action: %s" % action}
    except Exception as e:
        return {"error": "resolve action '%s' failed: %s" % (action, e)}

if __name__ == "__main__":
    sys.stdout.write(json.dumps(main()))
