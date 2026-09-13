const $ = (id) => document.getElementById(id);

const state = {
  settings: {},
  workflow: {},
  running: false,
  generating: false,
  prefilled: false,
  segmentCounter: 0,
  buffer: [],
  pendingChat: [],
  chatHistory: [],
  activePlayer: 0,
  currentSegment: null,
  generationStartedAt: null,
};

const players = [$('playerA'), $('playerB')];
players[0].classList.add('active');

function setStatus(text, kind = 'idle') {
  $('statusText').textContent = text;
  $('statusDot').className = `status-dot ${kind}`;
}

function addMessage(who, text, cls = '') {
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  const whoEl = document.createElement('div');
  whoEl.className = 'who';
  whoEl.textContent = who;
  const body = document.createElement('div');
  body.textContent = text;
  el.append(whoEl, body);
  $('chatLog').appendChild(el);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
}

function updateMetrics() {
  $('bufferBadge').textContent = `${state.buffer.length} buffered`;
  $('queuedMetric').textContent = String(state.buffer.length);
  $('generatingMetric').textContent = state.generating ? 'Yes' : 'No';
  $('playingMetric').textContent = state.currentSegment ? `#${state.currentSegment.id}` : '—';
  $('stageEmpty').style.display = state.currentSegment ? 'none' : 'block';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseMaybeJson(text, fallback = {}) {
  if (!text || !text.trim()) return fallback;
  return JSON.parse(text);
}

function applyNodeInput(workflow, nodeId, inputName, value, required = false) {
  if (!nodeId || !inputName) {
    if (required) throw new Error(`Missing mapping for required input: ${inputName || 'unknown'}`);
    return;
  }
  const node = workflow[String(nodeId)];
  if (!node || !node.inputs) {
    if (required) throw new Error(`Workflow node ${nodeId} was not found or has no inputs`);
    return;
  }
  node.inputs[inputName] = value;
}

function recentChatText() {
  const turns = Math.max(0, Number(state.settings.historyTurns ?? 4));
  return state.chatHistory.slice(-turns).map((m) => `${m.who}: ${m.text}`).join('\n');
}

function renderTemplate(template, chatMessage = '') {
  return (template || '')
    .replaceAll('{base_prompt}', state.settings.basePrompt || '')
    .replaceAll('{chat_message}', chatMessage || '')
    .replaceAll('{chat_history}', recentChatText())
    .replaceAll('{scene_name}', state.settings.sceneName || '');
}

function buildPrompt(forceIdle = false) {
  if (!forceIdle && state.pendingChat.length) {
    const item = state.pendingChat.shift();
    return {
      type: 'chat',
      source: item,
      text: renderTemplate(state.settings.chatTemplate, item.text),
    };
  }
  return {
    type: 'idle',
    source: null,
    text: renderTemplate(state.settings.idleTemplate, ''),
  };
}

function buildWorkflow(forceIdle = false) {
  const workflow = deepClone(state.workflow);
  const mapping = state.settings.mapping || {};
  const promptInfo = buildPrompt(forceIdle);

  const staticOverrides = state.settings.staticOverrides || {};
  for (const [nodeId, inputs] of Object.entries(staticOverrides)) {
    for (const [inputName, value] of Object.entries(inputs || {})) {
      applyNodeInput(workflow, nodeId, inputName, value, false);
    }
  }

  applyNodeInput(workflow, mapping.promptNodeId, mapping.promptInput || 'text', promptInfo.text, true);

  if (state.settings.referenceImage && mapping.imageNodeId) {
    applyNodeInput(workflow, mapping.imageNodeId, mapping.imageInput || 'image', state.settings.referenceImage, false);
  }

  if (mapping.seedNodeId) {
    const seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    applyNodeInput(workflow, mapping.seedNodeId, mapping.seedInput || 'seed', seed, false);
  }

  return { workflow, promptInfo };
}

async function queuePrompt(workflow) {
  const res = await fetch('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    const detail = data.node_errors ? JSON.stringify(data.node_errors) : (data.error || res.statusText);
    throw new Error(`ComfyUI rejected the prompt: ${detail}`);
  }
  if (!data.prompt_id) throw new Error('ComfyUI did not return a prompt_id');
  return data.prompt_id;
}

function looksLikeMediaRecord(item) {
  return item && typeof item === 'object' && typeof item.filename === 'string';
}

function mediaUrl(item) {
  const params = new URLSearchParams({
    filename: item.filename,
    subfolder: item.subfolder || '',
    type: item.type || 'output',
  });
  return `/view?${params.toString()}`;
}

function extractMediaFromHistory(history, promptId) {
  const record = history[promptId] || history[String(promptId)];
  if (!record || !record.outputs) return null;

  const mapping = state.settings.mapping || {};
  const preferredNode = mapping.outputNodeId ? record.outputs[String(mapping.outputNodeId)] : null;
  const preferredKey = mapping.outputKey || 'videos';

  if (preferredNode) {
    const preferred = preferredNode[preferredKey];
    if (Array.isArray(preferred) && preferred.length && looksLikeMediaRecord(preferred[0])) {
      return preferred[0];
    }
    for (const value of Object.values(preferredNode)) {
      if (Array.isArray(value)) {
        const found = value.find(looksLikeMediaRecord);
        if (found) return found;
      }
    }
  }

  for (const output of Object.values(record.outputs)) {
    if (!output || typeof output !== 'object') continue;
    for (const value of Object.values(output)) {
      if (!Array.isArray(value)) continue;
      const found = value.find(looksLikeMediaRecord);
      if (found) return found;
    }
  }
  return null;
}

async function waitForHistory(promptId) {
  const started = Date.now();
  const timeoutMs = 45 * 60 * 1000;
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`/history/${encodeURIComponent(promptId)}`);
    if (res.ok) {
      const history = await res.json();
      const record = history[promptId] || history[String(promptId)];
      if (record) {
        const media = extractMediaFromHistory(history, promptId);
        if (media) return media;

        const status = record.status;
        if (status && status.completed === true) {
          throw new Error('Generation completed, but no media file was found in the selected output node. Check Output node ID / key.');
        }
      }
    }
    await sleep(1000);
  }
  throw new Error('Timed out waiting for ComfyUI generation to finish');
}

async function generateSegment(forceIdle = false) {
  if (state.generating) return null;
  state.generating = true;
  state.generationStartedAt = performance.now();
  updateMetrics();
  setStatus(forceIdle ? 'Prefilling buffer…' : 'Generating next segment…', 'busy');

  try {
    const { workflow, promptInfo } = buildWorkflow(forceIdle);
    const promptId = await queuePrompt(workflow);
    const media = await waitForHistory(promptId);
    const elapsed = (performance.now() - state.generationStartedAt) / 1000;
    $('lastGenMetric').textContent = `${elapsed.toFixed(1)}s`;

    const segment = {
      id: ++state.segmentCounter,
      promptId,
      url: mediaUrl(media),
      media,
      promptType: promptInfo.type,
      chat: promptInfo.source,
      createdAt: Date.now(),
    };

    state.buffer.push(segment);
    addMessage('system', `Generated segment #${segment.id}${segment.promptType === 'chat' ? ' for chat response' : ''}.`, 'system');
    prepareNextDeck();
    return segment;
  } finally {
    state.generating = false;
    updateMetrics();
    if (state.running) setStatus('Live', 'live');
  }
}

function resetPlayer(player) {
  player.pause();
  player.removeAttribute('src');
  player.load();
  delete player.dataset.segmentId;
}

function prepareNextDeck() {
  if (!state.currentSegment || !state.buffer.length) return;
  const inactive = players[1 - state.activePlayer];
  const next = state.buffer[0];
  if (inactive.dataset.segmentId === String(next.id)) return;
  resetPlayer(inactive);
  inactive.src = next.url;
  inactive.preload = 'auto';
  inactive.dataset.segmentId = String(next.id);
  inactive.load();
}

async function startPlaybackIfNeeded() {
  if (state.currentSegment || !state.buffer.length) return;
  const first = state.buffer.shift();
  state.currentSegment = first;
  const player = players[state.activePlayer];
  resetPlayer(player);
  player.src = first.url;
  player.dataset.segmentId = String(first.id);
  player.classList.add('active');
  player.muted = true;
  $('muteBtn').textContent = 'Unmute';
  try { await player.play(); } catch (_) {}
  prepareNextDeck();
  updateMetrics();
}

async function advancePlayback() {
  if (!state.running) return;

  if (!state.buffer.length) {
    state.currentSegment = null;
    updateMetrics();
    setStatus('Buffer underrun — generating…', 'busy');
    while (state.running && !state.buffer.length) {
      if (!state.generating) await generateSegment(false);
      else await sleep(250);
    }
    if (!state.running) return;
    await startPlaybackIfNeeded();
    return;
  }

  const next = state.buffer.shift();
  const oldIndex = state.activePlayer;
  const newIndex = 1 - oldIndex;
  const oldPlayer = players[oldIndex];
  const newPlayer = players[newIndex];

  if (newPlayer.dataset.segmentId !== String(next.id)) {
    resetPlayer(newPlayer);
    newPlayer.src = next.url;
    newPlayer.dataset.segmentId = String(next.id);
    newPlayer.load();
  }

  newPlayer.muted = oldPlayer.muted;
  newPlayer.classList.add('active');
  oldPlayer.classList.remove('active');
  state.activePlayer = newIndex;
  state.currentSegment = next;

  try { await newPlayer.play(); } catch (_) {}
  resetPlayer(oldPlayer);
  prepareNextDeck();
  updateMetrics();
}

players.forEach((player) => {
  player.addEventListener('ended', () => {
    if (player === players[state.activePlayer]) advancePlayback().catch(handleError);
  });
});

async function maintainBufferLoop() {
  while (state.running) {
    try {
      const target = Math.max(1, Number(state.settings.targetBuffer || 3));
      if (state.buffer.length < target && !state.generating) {
        await generateSegment(false);
      } else {
        await sleep(400);
      }
    } catch (err) {
      handleError(err);
      await sleep(1500);
    }
  }
}

async function startLive() {
  if (state.running) return;
  validateReady();
  state.running = true;
  state.prefilled = false;
  $('startBtn').disabled = true;
  $('stopBtn').disabled = false;
  setStatus('Prefilling buffer…', 'busy');

  const initial = Math.max(1, Number(state.settings.initialBuffer || 3));
  try {
    while (state.running && state.buffer.length < initial) {
      await generateSegment(true);
    }
    if (!state.running) return;
    state.prefilled = true;
    await startPlaybackIfNeeded();
    setStatus('Live', 'live');
    maintainBufferLoop();
  } catch (err) {
    stopLive();
    handleError(err);
  }
}

function stopLive() {
  state.running = false;
  state.prefilled = false;
  $('startBtn').disabled = false;
  $('stopBtn').disabled = true;
  setStatus('Stopped', 'idle');
  players.forEach(resetPlayer);
  players[0].classList.add('active');
  players[1].classList.remove('active');
  state.activePlayer = 0;
  state.currentSegment = null;
  state.buffer = [];
  updateMetrics();
}

function validateReady() {
  if (!state.workflow || !Object.keys(state.workflow).length) throw new Error('No API workflow is configured. Open Setup first.');
  const mapping = state.settings.mapping || {};
  if (!mapping.promptNodeId) throw new Error('Prompt node ID is required.');
  if (!mapping.outputNodeId) throw new Error('Output node ID is required.');
}

function handleError(err) {
  console.error(err);
  setStatus('Error', 'error');
  addMessage('error', err?.message || String(err), 'system');
}

function formToSettings() {
  return {
    sceneName: $('sceneName').value.trim(),
    initialBuffer: Number($('initialBuffer').value || 3),
    targetBuffer: Number($('targetBuffer').value || 3),
    historyTurns: Number($('historyTurns').value || 4),
    basePrompt: $('basePrompt').value,
    idleTemplate: $('idleTemplate').value,
    chatTemplate: $('chatTemplate').value,
    referenceImage: state.settings.referenceImage || '',
    staticOverrides: parseMaybeJson($('staticOverrides').value, {}),
    mapping: {
      promptNodeId: $('promptNodeId').value.trim(),
      promptInput: $('promptInput').value.trim() || 'text',
      imageNodeId: $('imageNodeId').value.trim(),
      imageInput: $('imageInput').value.trim() || 'image',
      seedNodeId: $('seedNodeId').value.trim(),
      seedInput: $('seedInput').value.trim() || 'seed',
      outputNodeId: $('outputNodeId').value.trim(),
      outputKey: $('outputKey').value.trim() || 'videos',
    },
  };
}

function settingsToForm(settings) {
  $('sceneName').value = settings.sceneName || '';
  $('initialBuffer').value = settings.initialBuffer ?? 3;
  $('targetBuffer').value = settings.targetBuffer ?? 3;
  $('historyTurns').value = settings.historyTurns ?? 4;
  $('basePrompt').value = settings.basePrompt || '';
  $('idleTemplate').value = settings.idleTemplate || $('idleTemplate').value;
  $('chatTemplate').value = settings.chatTemplate || $('chatTemplate').value;
  $('referenceName').textContent = settings.referenceImage || 'No image uploaded';
  $('staticOverrides').value = Object.keys(settings.staticOverrides || {}).length ? JSON.stringify(settings.staticOverrides, null, 2) : '';

  const mapping = settings.mapping || {};
  $('promptNodeId').value = mapping.promptNodeId || '';
  $('promptInput').value = mapping.promptInput || 'text';
  $('imageNodeId').value = mapping.imageNodeId || '';
  $('imageInput').value = mapping.imageInput || 'image';
  $('seedNodeId').value = mapping.seedNodeId || '';
  $('seedInput').value = mapping.seedInput || 'seed';
  $('outputNodeId').value = mapping.outputNodeId || '';
  $('outputKey').value = mapping.outputKey || 'videos';
}

async function uploadReferenceIfNeeded() {
  const file = $('referenceFile').files?.[0];
  if (!file) return state.settings.referenceImage || '';
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/live-h3-chat/api/upload-reference', { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Reference upload failed');
  return data.filename;
}

async function saveSetup(event) {
  event.preventDefault();
  try {
    const workflow = parseMaybeJson($('workflowJson').value, {});
    const settings = formToSettings();
    settings.referenceImage = await uploadReferenceIfNeeded();

    const res = await fetch('/live-h3-chat/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings, workflow }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Could not save setup');

    state.settings = settings;
    state.workflow = workflow;
    $('referenceName').textContent = settings.referenceImage || 'No image uploaded';
    $('setupDialog').close();
    addMessage('system', `Saved setup${settings.sceneName ? ` for “${settings.sceneName}”` : ''}.`, 'system');
    setStatus('Ready', 'idle');
  } catch (err) {
    handleError(err);
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/live-h3-chat/api/config');
    const data = await res.json();
    state.settings = data.settings || {};
    state.workflow = data.workflow || {};
    settingsToForm(state.settings);
    $('workflowJson').value = Object.keys(state.workflow).length ? JSON.stringify(state.workflow, null, 2) : '';
    setStatus(Object.keys(state.workflow).length ? 'Ready' : 'Setup required', 'idle');
  } catch (err) {
    handleError(err);
  }
}

$('setupBtn').addEventListener('click', () => $('setupDialog').showModal());
$('saveSetupBtn').addEventListener('click', saveSetup);
$('startBtn').addEventListener('click', () => startLive().catch(handleError));
$('stopBtn').addEventListener('click', stopLive);
$('stopBtn').disabled = true;

$('muteBtn').addEventListener('click', async () => {
  const muted = !players[state.activePlayer].muted;
  players.forEach((p) => { p.muted = muted; });
  $('muteBtn').textContent = muted ? 'Unmute' : 'Mute';
  if (!muted && state.currentSegment) {
    try { await players[state.activePlayer].play(); } catch (_) {}
  }
});

$('chatForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  const item = { who: 'viewer', text, at: Date.now() };
  state.pendingChat.push(item);
  state.chatHistory.push(item);
  addMessage('you', text, 'user');
  $('chatInput').value = '';
  if (!state.running) addMessage('system', 'Message queued; it will be used after you start the scene.', 'system');
});

$('clearChatBtn').addEventListener('click', () => {
  state.pendingChat = [];
  state.chatHistory = [];
  $('chatLog').innerHTML = '';
});

$('referenceFile').addEventListener('change', () => {
  const file = $('referenceFile').files?.[0];
  if (file) $('referenceName').textContent = `Selected: ${file.name}`;
});

window.addEventListener('beforeunload', () => {
  state.running = false;
});

updateMetrics();
loadConfig();
