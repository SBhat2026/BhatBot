#!/usr/bin/env python3
"""Turn a 2D image into a watertight, 3D-printable mesh (STL), or convert an existing
3D model (GLB/OBJ/PLY) to STL.

Subcommands
  extrude  IMG  --out OUT.stl  [--height 4] [--base 0] [--size 60] [--invert] [--thresh -1]
      Silhouette extrusion: threshold the image to a shape and extrude it into a solid
      prism. Great for logos, stamps, cookie-cutters, keychains, name plates.

  relief   IMG  --out OUT.stl  [--height 3] [--base 0.8] [--size 80] [--invert] [--res 250]
      Height-map / lithophane: map pixel brightness to height, producing a relief surface
      on a solid base. Use --invert for a classic backlit lithophane (dark = thick).

  convert  MODEL --out OUT.stl
      Convert an existing 3D model (e.g. a TRELLIS .glb) to a printable STL.

All units are millimetres. Prints a one-line JSON summary to stdout.
"""
import sys, json, argparse
import numpy as np


def _emit(d):
    print(json.dumps(d)); sys.exit(0 if d.get("ok") else 1)


def _load_gray(path, invert):
    from PIL import Image
    im = Image.open(path).convert("L")
    a = np.asarray(im, dtype=np.float32) / 255.0
    if invert:
        a = 1.0 - a
    return a, im.size  # (W,H)


def _stats(mesh, out):
    ext = mesh.bounding_box.extents
    try:
        vol = float(mesh.volume) / 1000.0  # mm^3 -> cm^3
    except Exception:
        vol = None
    return {
        "ok": True, "path": out,
        "vertices": int(len(mesh.vertices)), "faces": int(len(mesh.faces)),
        "watertight": bool(mesh.is_watertight),
        "dims_mm": [round(float(x), 2) for x in ext],
        "volume_cm3": round(vol, 2) if vol is not None else None,
    }


def cmd_extrude(args):
    import cv2, trimesh
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    gray, _ = _load_gray(args.image, args.invert)
    img = (gray * 255).astype(np.uint8)
    # cap resolution for fast, clean contours
    h, w = img.shape
    longest = max(h, w)
    if longest > 1000:
        s = 1000.0 / longest
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
        h, w = img.shape

    if args.thresh is not None and args.thresh >= 0:
        _, binimg = cv2.threshold(img, int(args.thresh), 255, cv2.THRESH_BINARY)
    else:
        _, binimg = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    cnts, hier = cv2.findContours(binimg, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        _emit({"ok": False, "error": "No shape found after thresholding. Try --invert or a clearer image."})
    hier = hier[0]
    polys = []
    for i, c in enumerate(cnts):
        if hier[i][3] != -1:  # this is a hole; handled with its parent
            continue
        if len(c) < 3:
            continue
        ext = c.reshape(-1, 2)
        holes = []
        child = hier[i][2]
        while child != -1:
            hc = cnts[child].reshape(-1, 2)
            if len(hc) >= 3:
                holes.append(hc)
            child = hier[child][0]
        try:
            p = Polygon(ext, holes).buffer(0)
            if not p.is_empty and p.area > 4:
                polys.append(p)
        except Exception:
            pass
    if not polys:
        _emit({"ok": False, "error": "Could not build polygons from the silhouette."})

    shape = unary_union(polys)
    # scale so the longest side == size mm, flip Y so it prints upright
    scale = float(args.size) / float(max(w, h))

    def _scale_poly(p):
        from shapely.affinity import scale as sc
        p = sc(p, xfact=scale, yfact=-scale, origin=(0, 0))
        # simplify away contour noise → far more reliable triangulation / watertight caps
        p = p.simplify(scale * 0.6, preserve_topology=True).buffer(0)
        return p

    def _as_volume(m):
        """Best-effort repair so a part is a closed volume manifold can union."""
        if m.is_volume:
            return m
        try:
            m.merge_vertices(); m.remove_degenerate_faces(); m.remove_duplicate_faces()
            trimesh.repair.fill_holes(m); trimesh.repair.fix_normals(m)
        except Exception:
            pass
        return m

    geoms = shape.geoms if shape.geom_type == "MultiPolygon" else [shape]
    parts = []
    z0 = float(args.base)
    for g in geoms:
        g = _scale_poly(g)
        if g.is_empty or g.area <= 0:
            continue
        sub = g.geoms if g.geom_type == "MultiPolygon" else [g]
        for gg in sub:
            try:
                m = trimesh.creation.extrude_polygon(gg, height=float(args.height))
                m.apply_translation([0, 0, z0])
                parts.append(_as_volume(m))
            except Exception:
                pass
    if not parts:
        _emit({"ok": False, "error": "Extrusion failed."})

    if args.base and args.base > 0:
        bb = trimesh.util.concatenate(parts).bounds if len(parts) > 1 else parts[0].bounds
        bx, by = bb[1][0] - bb[0][0], bb[1][1] - bb[0][1]
        base = trimesh.creation.box(extents=[bx, by, float(args.base)])
        base.apply_translation([(bb[0][0] + bb[1][0]) / 2, (bb[0][1] + bb[1][1]) / 2, float(args.base) / 2])
        parts.append(base)

    # Union the valid volumes into ONE watertight solid via manifold3d; anything that still
    # isn't a clean volume gets concatenated on (it still prints — slicers union overlapping
    # closed bodies). This keeps one bad glyph from sinking the whole union.
    vols = [m for m in parts if m.is_volume]
    rest = [m for m in parts if not m.is_volume]
    mesh = None
    if len(vols) > 1:
        try:
            mesh = trimesh.boolean.union(vols)
        except Exception:
            mesh = trimesh.util.concatenate(vols)
    elif len(vols) == 1:
        mesh = vols[0]
    if rest:
        mesh = trimesh.util.concatenate(([mesh] if mesh is not None else []) + rest)
    if mesh is None:
        mesh = trimesh.util.concatenate(parts)

    # recenter on origin XY, sit on bed (z=0)
    b = mesh.bounds
    mesh.apply_translation([-(b[0][0] + b[1][0]) / 2, -(b[0][1] + b[1][1]) / 2, -b[0][2]])
    mesh.export(args.out)
    _emit(_stats(mesh, args.out))


def cmd_relief(args):
    import trimesh
    gray, _ = _load_gray(args.image, args.invert)
    h, w = gray.shape
    longest = max(h, w)
    res = int(args.res)
    if longest > res:
        from PIL import Image
        im = Image.fromarray((gray * 255).astype(np.uint8)).resize(
            (max(2, int(w * res / longest)), max(2, int(h * res / longest))), Image.LANCZOS)
        gray = np.asarray(im, dtype=np.float32) / 255.0
        h, w = gray.shape

    scale = float(args.size) / float(max(w, h))
    base = float(args.base); relief = float(args.height)
    # grid of XY (mm), Z = base + brightness*relief
    xs = (np.arange(w) - w / 2.0) * scale
    ys = (h / 2.0 - np.arange(h)) * scale       # flip Y
    X, Y = np.meshgrid(xs, ys)
    Ztop = base + gray * relief

    # top vertices
    top = np.column_stack([X.ravel(), Y.ravel(), Ztop.ravel()])
    bot = np.column_stack([X.ravel(), Y.ravel(), np.zeros(w * h)])
    n = w * h
    verts = np.vstack([top, bot])

    def vid(r, c, bottom=False):
        return (r * w + c) + (n if bottom else 0)

    faces = []
    # top surface
    for r in range(h - 1):
        for c in range(w - 1):
            a, b2, cc, d = vid(r, c), vid(r, c + 1), vid(r + 1, c + 1), vid(r + 1, c)
            faces.append([a, b2, cc]); faces.append([a, cc, d])
    # bottom surface (reversed winding)
    for r in range(h - 1):
        for c in range(w - 1):
            a, b2, cc, d = vid(r, c, True), vid(r, c + 1, True), vid(r + 1, c + 1, True), vid(r + 1, c, True)
            faces.append([a, cc, b2]); faces.append([a, d, cc])
    # side walls
    for c in range(w - 1):
        a, b2 = vid(0, c), vid(0, c + 1)
        faces.append([a, b2, vid(0, c + 1, True)]); faces.append([a, vid(0, c + 1, True), vid(0, c, True)])
        a, b2 = vid(h - 1, c), vid(h - 1, c + 1)
        faces.append([a, vid(h - 1, c + 1, True), b2]); faces.append([a, vid(h - 1, c, True), vid(h - 1, c + 1, True)])
    for r in range(h - 1):
        a, b2 = vid(r, 0), vid(r + 1, 0)
        faces.append([a, vid(r + 1, 0, True), b2]); faces.append([a, vid(r, 0, True), vid(r + 1, 0, True)])
        a, b2 = vid(r, w - 1), vid(r + 1, w - 1)
        faces.append([a, b2, vid(r + 1, w - 1, True)]); faces.append([a, vid(r + 1, w - 1, True), vid(r, w - 1, True)])

    mesh = trimesh.Trimesh(vertices=verts, faces=np.array(faces), process=True)
    mesh.export(args.out)
    _emit(_stats(mesh, args.out))


def cmd_convert(args):
    import trimesh
    obj = trimesh.load(args.model, force="mesh")
    if obj is None or (hasattr(obj, "is_empty") and obj.is_empty):
        _emit({"ok": False, "error": "Could not load model or it is empty."})
    if not isinstance(obj, trimesh.Trimesh):
        try:
            obj = trimesh.util.concatenate(tuple(obj.geometry.values()))
        except Exception:
            _emit({"ok": False, "error": "Model has no extractable mesh geometry."})
    obj.export(args.out)
    _emit(_stats(obj, args.out))


def main():
    p = argparse.ArgumentParser(description="2D image → printable 3D mesh (STL).")
    sub = p.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("extrude"); e.add_argument("image"); e.add_argument("--out", required=True)
    e.add_argument("--height", type=float, default=4.0); e.add_argument("--base", type=float, default=0.0)
    e.add_argument("--size", type=float, default=60.0); e.add_argument("--invert", action="store_true")
    e.add_argument("--thresh", type=float, default=-1); e.set_defaults(fn=cmd_extrude)

    r = sub.add_parser("relief"); r.add_argument("image"); r.add_argument("--out", required=True)
    r.add_argument("--height", type=float, default=3.0); r.add_argument("--base", type=float, default=0.8)
    r.add_argument("--size", type=float, default=80.0); r.add_argument("--invert", action="store_true")
    r.add_argument("--res", type=int, default=250); r.set_defaults(fn=cmd_relief)

    c = sub.add_parser("convert"); c.add_argument("model"); c.add_argument("--out", required=True)
    c.set_defaults(fn=cmd_convert)

    args = p.parse_args()
    try:
        args.fn(args)
    except Exception as ex:
        _emit({"ok": False, "error": f"{type(ex).__name__}: {ex}"})


if __name__ == "__main__":
    main()
