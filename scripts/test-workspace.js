'use strict';
// In-app windowing (lib/panes.js) and memory-pressure hysteresis.
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { EventEmitter } = require('events');
const { createPaneHost } = require('../lib/panes');
const { createPressureTracker } = require('../lib/memrelief');

// A fake WebContentsView/main window, recording what main would do to the native views.
const sent = [];
class FakeWC extends EventEmitter { constructor() { super(); this.closed = false; } loadFile() {} loadURL() {} reload() {} focus() {} isFocused() { return false; } isDestroyed() { return this.closed; } close() { this.closed = true; } }
class FakeView { constructor() { this.webContents = new FakeWC(); this.bounds = null; this.visible = null; } setBounds(b) { this.bounds = b; } setVisible(v) { this.visible = v; } setBackgroundColor() {} getBounds() { return this.bounds; } }
const children = new Set();
const main = { isDestroyed: () => false, webContents: { send: (ch, d) => sent.push([ch, d]) }, contentView: { addChildView: (v) => children.add(v), removeChildView: (v) => children.delete(v) } };
const host = createPaneHost({ WebContentsView: FakeView, getMainWindow: () => main });

const a = new host.PaneWindow({ title: 'Brain' });
const b = new host.PaneWindow({ title: 'Maps' });
assert.equal(children.size, 2, 'a pane is a view inside the main window, not a desktop window');
const last = () => sent.filter(([c]) => c === 'panes').pop()[1];
assert.deepEqual(last().map((p) => p.title).sort(), ['Brain', 'Maps'], 'the renderer is told which panes exist');
assert.equal(a.view.visible, false, 'nothing is drawn until the renderer says where');
host.place({ [a.paneId]: { x: 10.4, y: 20, width: 300, height: 200 }, [b.paneId]: null });
assert.deepEqual(a.view.bounds, { x: 10, y: 20, width: 300, height: 200 }); assert.equal(a.view.visible, true);
assert.equal(b.view.visible, false, 'a pane with no rect (palette open, another card expanded) is hidden');
let closed = 0; b.on('closed', () => closed++);
host.close(b.paneId);
assert(closed === 1 && b.isDestroyed() && !children.has(b.view) && b.view.webContents.closed, 'closing a pane closes its page and removes its view');
assert.deepEqual(last().map((p) => p.title), ['Brain']);
// The BrowserWindow calls existing openers make are all accepted.
for (const m of ['show', 'focus', 'setBounds', 'center', 'setAlwaysOnTop', 'setMenuBarVisibility', 'setTitle', 'getBounds', 'isVisible', 'isMinimized']) assert.equal(typeof a[m], 'function', m);
a.webContents.emit('destroyed');
assert(a.isDestroyed(), 'a page that closes itself closes its pane');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
assert(/BrowserWindow: ToolWindow/.test(src), 'window-manager tool windows open as panes');
for (const v of ['brainWindow', 'terminalWindow', 'blenderWin', 'actionViewWin']) assert(new RegExp(v + ' = new ToolWindow\\(').test(src), v + ' opens as a pane');
assert(!/setBounds\(\{ windowId|browserExternal/.test(src), 'BhatBot no longer moves windows on his desktop');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
assert(/window\.bhatbot\.paneRects/.test(html) && /onPanes\(/.test(html), 'the renderer places panes');

let track = createPressureTracker(); assert.equal(track(9).active, false); assert.equal(track(8).active, true); assert.equal(track(15).active, true); assert.equal(track(20).active, true); assert.equal(track(20).active, true); assert.equal(track(20).active, false);
track = createPressureTracker(); assert.equal(track(4).level, 'critical'); assert.equal(track(null).active, true);
console.log('In-app panes and memory pressure hysteresis passed');
