#!/usr/bin/env python3
"""
Persistent OmniParser worker for BhatBot — vision-driven desktop control (item 2).

Loaded ONCE and kept warm (like kokoro_worker). Reads one JSON request per line on stdin,
writes one JSON response per line on stdout. Commands:

  {"id":1,"cmd":"ping"}                                  -> {"id":1,"ok":true,"ready":true}
  {"id":2,"cmd":"parse","image_b64":"...","semantics":false}
        -> {"id":2,"ok":true,"w":W,"h":H,"elements":[
              {"i":0,"type":"text|icon","content":"Login","interactivity":true,
               "bbox":[x0,y0,x1,y1],          # ratios 0..1
               "center":[cx,cy]}]}            # ratios 0..1
     semantics=false  -> OCR + icon detection only (~4-5s, fast; good for clicking)
     semantics=true   -> also caption icons via Florence-2 (slow ~60s; richer labels)
  {"id":3,"cmd":"click","x":640,"y":400,"double":false}   # ABSOLUTE screen POINTS
        -> {"id":3,"ok":true}
  {"id":4,"cmd":"move","x":640,"y":400}                    # move cursor only

Run:  python3 omniparser_worker.py /path/to/OmniParser
Cwd is switched to the OmniParser dir so its `util` package + `weights/` resolve.
"""
import sys, os, json, base64, io, time, traceback

OMNI_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/bhatbot/OmniParser')
os.chdir(OMNI_DIR)
sys.path.insert(0, OMNI_DIR)

# Keep stdout PURE JSON: libraries (ultralytics/easyocr) print progress to stdout, which would
# corrupt the line protocol. Reserve the real stdout for responses; route everything else to stderr.
_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

def out(obj):
    _REAL_STDOUT.write(json.dumps(obj) + '\n'); _REAL_STDOUT.flush()

# --- lazy, warm singletons ---
_yolo = None
_caption = None

def yolo():
    global _yolo
    if _yolo is None:
        from util.utils import get_yolo_model
        _yolo = get_yolo_model(model_path='weights/icon_detect/model.pt')
    return _yolo

def caption():
    global _caption
    if _caption is None:
        import torch
        from util.utils import get_caption_model_processor
        dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
        _caption = get_caption_model_processor(model_name='florence2', model_name_or_path='weights/icon_caption_florence', device=dev)
    return _caption

def do_parse(req):
    from PIL import Image
    from util.utils import check_ocr_box, get_som_labeled_img
    semantics = bool(req.get('semantics', False))
    img = Image.open(io.BytesIO(base64.b64decode(req['image_b64'])))
    W, H = img.size
    (text, ocr_bbox), _ = check_ocr_box(img, display_img=False, output_bb_format='xyxy',
                                        easyocr_args={'text_threshold': 0.8}, use_paddleocr=False)
    kw = dict(BOX_TRESHOLD=req.get('box_threshold', 0.05), output_coord_in_ratio=True, ocr_bbox=ocr_bbox,
              ocr_text=text, iou_threshold=0.7, scale_img=False, use_local_semantics=semantics)
    if semantics:
        kw['caption_model_processor'] = caption(); kw['batch_size'] = 128
    _, _coords, parsed = get_som_labeled_img(img, yolo(), **kw)
    elems = []
    for i, p in enumerate(parsed):
        b = p.get('bbox') or [0, 0, 0, 0]
        elems.append({'i': i, 'type': p.get('type'), 'content': (p.get('content') or '').strip(),
                      'interactivity': bool(p.get('interactivity')),
                      'bbox': [round(float(x), 4) for x in b],
                      'center': [round((b[0] + b[2]) / 2, 4), round((b[1] + b[3]) / 2, 4)]})
    return {'ok': True, 'w': W, 'h': H, 'elements': elems}

def do_click(req):
    import Quartz
    x, y = float(req['x']), float(req['y'])
    dbl = bool(req.get('double', False))
    def post(evtype, clicks):
        e = Quartz.CGEventCreateMouseEvent(None, evtype, (x, y), Quartz.kCGMouseButtonLeft)
        if clicks: Quartz.CGEventSetIntegerValueField(e, Quartz.kCGMouseEventClickState, clicks)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (x, y), 0))
    time.sleep(0.05)
    post(Quartz.kCGEventLeftMouseDown, 1); post(Quartz.kCGEventLeftMouseUp, 1)
    if dbl:
        time.sleep(0.05); post(Quartz.kCGEventLeftMouseDown, 2); post(Quartz.kCGEventLeftMouseUp, 2)
    return {'ok': True}

def do_move(req):
    import Quartz
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (float(req['x']), float(req['y'])), 0))
    return {'ok': True}

def main():
    out({'id': 0, 'ok': True, 'event': 'started', 'dir': OMNI_DIR})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line); rid = req.get('id')
            cmd = req.get('cmd')
            if cmd == 'ping':
                yolo(); res = {'ok': True, 'ready': True}
            elif cmd == 'parse':
                res = do_parse(req)
            elif cmd == 'click':
                res = do_click(req)
            elif cmd == 'move':
                res = do_move(req)
            else:
                res = {'ok': False, 'error': 'unknown cmd: %s' % cmd}
        except Exception as e:
            res = {'ok': False, 'error': str(e), 'trace': traceback.format_exc()[-600:]}
        res['id'] = rid
        out(res)

if __name__ == '__main__':
    main()
