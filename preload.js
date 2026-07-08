'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bhatbot', {
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  saveApiKey: (key) => ipcRenderer.invoke('save-api-key', key),
  chat: (payload) => ipcRenderer.invoke('chat', payload),
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  pickMedia: () => ipcRenderer.invoke('pick-media'),
  getContextPath: () => ipcRenderer.invoke('get-context-path'),
  getMemoryPath: () => ipcRenderer.invoke('get-memory-path'),
  getVoiceConfig: () => ipcRenderer.invoke('get-voice-config'),
  endpointThreshold: () => ipcRenderer.invoke('endpoint-threshold'),                 // adaptive silence-wait (learned per user)
  endpointObserve: (ms, resumed) => ipcRenderer.invoke('endpoint-observe', { ms, resumed }), // report a mid-utterance pause to learn
  setTtsSpeed: (v) => ipcRenderer.invoke('set-tts-speed', v),
  getVoiceSettings: () => ipcRenderer.invoke('get-voice-settings'),                 // D — current JARVIS voice params
  setVoiceSetting: (key, value) => ipcRenderer.invoke('set-voice-setting', { key, value }),
  importVoiceSamples: () => ipcRenderer.invoke('import-voice-samples'),             // D — clone/improve voice from audio files
  listVoices: () => ipcRenderer.invoke('list-voices'),                              // Voice panel — ElevenLabs voice picker
  setVoice: (voiceId) => ipcRenderer.invoke('set-voice', { voiceId }),
  setVoiceModel: (model) => ipcRenderer.invoke('set-voice-model', { model }),
  applyVoicePreset: (preset) => ipcRenderer.invoke('apply-voice-preset', { preset }),
  onFleetUpdate: (cb) => ipcRenderer.on('fleet-update', (_e, d) => cb(d)),           // C-Fleet — live suit relay
  sendFleetFeedback: (id, text) => ipcRenderer.invoke('fleet-feedback', { id, text }),
  sendFleetControl: (id, action) => ipcRenderer.invoke('fleet-control', { id, action }),
  openAgentWindow: (id) => ipcRenderer.invoke('open-agent-window', id),
  openActionView: () => ipcRenderer.invoke('open-action-view'),
  getHealth: () => ipcRenderer.invoke('get-health'),
  getBiometrics: (opts) => ipcRenderer.invoke('get-biometrics', opts),                  // Health panel — Garmin biometrics
  onBiometricsUpdate: (cb) => ipcRenderer.on('biometrics-update', (_e, d) => cb(d)),     // proactive monitor pushes
  getOpsStatus: () => ipcRenderer.invoke('get-ops-status'),                              // Manage panel — what BhatBot is running
  transcribeAudio: (data) => ipcRenderer.invoke('transcribe-audio', data),
  synthesizeSpeech: (text) => ipcRenderer.invoke('synthesize-speech', { text }),
  playTTS: (text, full) => ipcRenderer.invoke('play-tts', { text, full }),
  stopTTS: () => ipcRenderer.invoke('stop-tts'),
  summarizeForSpeech: (text) => ipcRenderer.invoke('summarize-for-speech', { text }),
  sayLocal: (text) => ipcRenderer.invoke('say-local', { text }),
  openNexus: () => ipcRenderer.invoke('open-nexus'),
  openStudio: () => ipcRenderer.invoke('open-studio'),
  openTerminal: () => ipcRenderer.invoke('open-terminal'),
  getPanelUrls: () => ipcRenderer.invoke('get-panel-urls'),
  focusBrowser: () => ipcRenderer.invoke('focus-browser'),
  onShowPanel: (cb) => ipcRenderer.on('show-panel', (_e, id) => cb(id)),
  onStudioReload: (cb) => ipcRenderer.on('studio-reload', () => cb()),
  onWakeCommand: (cb) => ipcRenderer.on('wake-command', (_e, d) => cb(d.text)),
  onBargeIn: (cb) => ipcRenderer.on('barge-in', (_e, d) => cb(d)),
  onTtsIdle: (cb) => ipcRenderer.on('tts-idle', (_e, d) => cb(d)),
  ensurePermissions: (opts) => ipcRenderer.invoke('ensure-permissions', opts),
  permStatus: () => ipcRenderer.invoke('perm-status'),
  sendGuidance: (text) => ipcRenderer.send('agent-guidance', { text }),
  listNotes: () => ipcRenderer.invoke('list-notes'),
  listRoutines: () => ipcRenderer.invoke('list-routines'),
  routineAction: (id, action, value) => ipcRenderer.invoke('routine-action', { id, action, value }),
  onRateStatus: (cb) => ipcRenderer.on('rate-status', (_e, p) => cb(p)),
  onOptionsRequired: (cb) => ipcRenderer.on('options-required', (_e, p) => cb(p)),
  answerOptions: (id, selected, text) => ipcRenderer.send('options-answer', { id, selected, text }),
  onFormRequired: (cb) => ipcRenderer.on('form-required', (_e, p) => cb(p)),
  answerForm: (id, values, dismissed) => ipcRenderer.send('form-answer', { id, values, dismissed }),
  onSpeechSummary: (cb) => ipcRenderer.on('speech-summary', (_e, p) => cb(p)),
  onCanvasAdd: (cb) => ipcRenderer.on('canvas-add', (_e, p) => cb(p)),
  onCanvasClear: (cb) => ipcRenderer.on('canvas-clear', (_e, p) => cb(p)),
  voiceGate: (text) => { try { return require('./lib/pure').looksActionable(text); } catch { return { action: 'ok', reason: 'gate-error' }; } },
  voiceIntent: (text) => ipcRenderer.invoke('voice-intent', { text }),
  onToggleVoiceLock: (cb) => ipcRenderer.on('toggle-voice-lock', () => cb()),
  endSession: () => ipcRenderer.send('end-session'),
  onSessionNote: (cb) => ipcRenderer.on('session-note', (_e, n) => cb(n)),
  attachPaths: (paths) => ipcRenderer.invoke('attach-paths', paths),
  credStore: (c) => ipcRenderer.invoke('cred-store', c),
  credList: () => ipcRenderer.invoke('cred-list'),
  credRemove: (ref) => ipcRenderer.invoke('cred-remove', { ref }),
  readModel: (p) => ipcRenderer.invoke('read-model', p),
  open3DViewer: (p) => ipcRenderer.invoke('open-3d-viewer', p),
  onToolUpdate: (cb) => ipcRenderer.on('tool-update', (_e, u) => cb(u)),
  onJobUpdate: (cb) => ipcRenderer.on('job-update', (_e, j) => cb(j)),
  // Step-up / confirm gate (was orphaned in preload-activity.js when Activity moved in-window).
  // Restores the human-approval card for stepup/confirm-tier tools (self_drive, etc.).
  onConfirmRequired: (cb) => ipcRenderer.on('confirm-required', (_e, c) => cb(c)),
  confirmRespond: (id, approved) => ipcRenderer.send('confirm-response', { id, approved }),
  removeToolUpdateListener: () => ipcRenderer.removeAllListeners('tool-update')
});

// Embedded Claude Code terminal (pty) — same API the standalone terminal window uses,
// so the xterm panel can live inside the main HUD.
contextBridge.exposeInMainWorld('term', {
  start: (cols, rows) => ipcRenderer.send('pty-start', { cols, rows }),
  input: (data) => ipcRenderer.send('pty-input', data),
  resize: (cols, rows) => ipcRenderer.send('pty-resize', { cols, rows }),
  onData: (cb) => ipcRenderer.on('pty-data', (_e, d) => cb(d)),
  onExit: (cb) => ipcRenderer.on('pty-exit', () => cb())
});
