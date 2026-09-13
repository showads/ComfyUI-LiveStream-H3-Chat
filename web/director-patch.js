// Live H3 runtime v2: FL2VA continuity, temporal planning, chat preemption,
// trace-based LLM/H3 observability, media probing, and canonical-frame resets.
// Loaded after app.js so it can replace the MVP runtime while retaining the UI shell.

state.diagnostics = state.diagnostics || [];
state.continuityFrame = state.continuityFrame || '';
state.chainDepth = state.chainDepth || 0;
state.generationEpoch = state.generationEpoch || 0;
state.currentGenerationMeta = null;

const H3_FPS = 24;
const H3_MIN_TRAINED_FRAMES = 124;
const H3_MAX_TRAINED_FRAMES = 362;

function h3FramePlan(seconds) {
  const desiredSeconds = Math.max(0.1, Number(seconds || 5.2));
  const requestedFrames = Math.round(desiredSeconds * H3_FPS);
  let alignedFrames = Math.max(H3_MIN_TRAINED_FRAMES, Math.min(H3_MAX_TRAINED_FRAMES, requestedFrames));
  while (alignedFrames % 17 !== 5 && alignedFrames < H3_MAX_TRAINED_FRAMES) alignedFrames += 1;
  alignedFrames = Math.min(alignedFrames, H3_MAX_TRAINED_FRAMES);
  return {
    fps: H3_FPS,
    desiredSeconds,
    requestedFrames,
    alignedFrames,
    modelSeconds: alignedFrames / H3_FPS,
    clamped: requestedFrames < H3_MIN_TRAINED_FRAMES || requestedFrames > H3_MAX_TRAINED_FRAMES,
  };
}

function fmtSeconds(value, digits = 1) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}s` : '—';
}

function fmtMs(value) {
  if (!Number.isFinite(Number(value))) return '—';
  const ms = Number(value);
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function shortName(path) {
  if (!path) return 'canonical';
  const bits = String(path).split('/');
  return bits[bits.length - 1] || String(path);
}

function bufferedSeconds() {
  return state.buffer.reduce((sum, segment) => sum + Number(segment.actualDuration || segment.modelSeconds || 0), 0);
}

function setField(id, value) {
  const el = $(id);
  if (el) el.value = value ?? '';
}

function getField(id, fallback = '') {
  const el = $(id);
  return el ? el.value : fallback;
}

function getNumberField(id, fallback) {
  const n = Number(getField(id, fallback));
  return Number.isFinite(n) ? n : fallback;
}

// Backward-compatible settings serialization. We no longer use segment-count
// buffering internally, but retain legacy values in hidden fields for app.js.
formToSettings = function () {
  return {
    sceneName: getField('sceneName').trim(),
    historyTurns: getNumberField('historyTurns', 4),
    initialBufferSeconds: getNumberField('initialBufferSeconds', 10),
    targetBufferSeconds: getNumberField('targetBufferSeconds', 12),
    idleSeconds: getNumberField('idleSeconds', 5.2),
    chatSeconds: getNumberField('chatSeconds', 7.3),
    resetSeconds: getNumberField('resetSeconds', 5.2),
    reanchorEvery: Math.max(0, Math.round(getNumberField('reanchorEvery', 4))),
    basePrompt: getField('basePrompt'),
    idleTemplate: getField('idleTemplate'),
    chatTemplate: getField('chatTemplate'),
    directorTemplate: getField('directorTemplate'),
    referenceImage: state.settings.referenceImage || '',
    staticOverrides: parseMaybeJson(getField('staticOverrides'), {}),
    mapping: {
      promptNodeId: getField('promptNodeId').trim(),
      promptInput: getField('promptInput', 'prompt').trim() || 'prompt',
      directorNodeId: getField('directorNodeId').trim(),
      directorInput: getField('directorInput', 'text').trim() || 'text',
      llmInputTraceNodeId: getField('llmInputTraceNodeId').trim(),
      llmOutputTraceNodeId: getField('llmOutputTraceNodeId').trim(),
      finalPromptTraceNodeId: getField('finalPromptTraceNodeId').trim(),
      traceInput: getField('traceInput', 'text').trim() || 'text',
      firstFrameNodeId: getField('firstFrameNodeId').trim(),
      firstFrameInput: getField('firstFrameInput', 'image').trim() || 'image',
      lastFrameNodeId: getField('lastFrameNodeId').trim(),
      lastFrameInput: getField('lastFrameInput', 'image').trim() || 'image',
      flNodeId: getField('flNodeId').trim(),
      lastFrameTargetInput: getField('lastFrameTargetInput', 'last_frame').trim() || 'last_frame',
      lengthNodeId: getField('lengthNodeId').trim(),
      lengthInput: getField('lengthInput', 'length').trim() || 'length',
      seedNodeId: getField('seedNodeId').trim(),
      seedInput: getField('seedInput', 'seed').trim() || 'seed',
      outputNodeId: getField('outputNodeId').trim(),
      outputKey: getField('outputKey', 'videos').trim() || 'videos',
    },
  };
};

settingsToForm = function (settings) {
  const mapping = settings.mapping || {};
  const migratedInitial = settings.initialBufferSeconds ?? ((settings.initialBuffer || 2) * 5.2);
  const migratedTarget = settings.targetBufferSeconds ?? ((settings.targetBuffer || 3) * 5.2);

  setField('sceneName', settings.sceneName || '');
  setField('historyTurns', settings.historyTurns ?? 4);
  setField('initialBufferSeconds', migratedInitial);
  setField('targetBufferSeconds', migratedTarget);
  setField('idleSeconds', settings.idleSeconds ?? 5.2);
  setField('chatSeconds', settings.chatSeconds ?? 7.3);
  setField('resetSeconds', settings.resetSeconds ?? 5.2);
  setField('reanchorEvery', settings.reanchorEvery ?? 4);
  setField('basePrompt', settings.basePrompt || '');
  if (settings.idleTemplate) setField('idleTemplate', settings.idleTemplate);
  if (settings.chatTemplate) setField('chatTemplate', settings.chatTemplate);
  if (settings.directorTemplate) setField('directorTemplate', settings.directorTemplate);
  if ($('referenceName')) $('referenceName').textContent = settings.referenceImage || 'No image uploaded';
  setField('staticOverrides', Object.keys(settings.staticOverrides || {}).length ? JSON.stringify(settings.staticOverrides, null, 2) : '');

  setField('promptNodeId', mapping.promptNodeId || '');
  setField('promptInput', mapping.promptInput || 'prompt');
  setField('directorNodeId', mapping.directorNodeId || '');
  setField('directorInput', mapping.directorInput || 'text');
  setField('llmInputTraceNodeId', mapping.llmInputTraceNodeId || '');
  setField('llmOutputTraceNodeId', mapping.llmOutputTraceNodeId || '');
  setField('finalPromptTraceNodeId', mapping.finalPromptTraceNodeId || '');
  setField('traceInput', mapping.traceInput || 'text');
  setField('firstFrameNodeId', mapping.firstFrameNodeId || mapping.imageNodeId || '');
  setField('firstFrameInput', mapping.firstFrameInput || mapping.imageInput || 'image');
  setField('lastFrameNodeId', mapping.lastFrameNodeId || '');
  setField('lastFrameInput', mapping.lastFrameInput || 'image');
  setField('flNodeId', mapping.flNodeId || mapping.promptNodeId || '');
  setField('lastFrameTargetInput', mapping.lastFrameTargetInput || 'last_frame');
  setField('lengthNodeId', mapping.lengthNodeId || mapping.promptNodeId || '');
  setField('lengthInput', mapping.lengthInput || 'length');
  setField('seedNodeId', mapping.seedNodeId || '');
  setField('seedInput', mapping.seedInput || 'seed');
  setField('outputNodeId', mapping.outputNodeId || '');
  setField('outputKey', mapping.outputKey || 'videos');

  // Hidden compatibility fields used by the original app.js during its first load.
  setField('initialBuffer', settings.initialBuffer || 2);
  setField('targetBuffer', settings.targetBuffer || 3);
  setField('imageNodeId', mapping.imageNodeId || mapping.firstFrameNodeId || '');
  setField('imageInput', mapping.imageInput || mapping.firstFrameInput || 'image');
};

mediaUrl = function (item) {
  const params = new URLSearchParams({
    filename: item.filename,
    subfolder: item.subfolder || '',
    type: item.type || 'output',
    _live_h3: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
  return `/view?${params.toString()}`;
};

function runtimeTemplate(template, chatMessage, context) {
  return renderTemplate(template || '', chatMessage || '')
    .replaceAll('{segment_seconds}', String(context.plan.modelSeconds.toFixed(3)))
    .replaceAll('{segment_frames}', String(context.plan.alignedFrames))
    .replaceAll('{is_reset}', context.isReset ? 'true' : 'false')
    .replaceAll('{reset_instruction}', context.isReset
      ? 'A final-frame keyframe is supplied. Move naturally from the starting frame and land precisely on the supplied final frame by the end of the single continuous shot.'
      : 'No final-frame keyframe is supplied; continue naturally from the starting frame.');
}

function choosePromptAndPlan(forceIdle, isReset) {
  const type = (!forceIdle && state.pendingChat.length) ? 'chat' : 'idle';
  const desired = isReset
    ? state.settings.resetSeconds
    : (type === 'chat' ? state.settings.chatSeconds : state.settings.idleSeconds);
  const plan = h3FramePlan(desired);
  const item = type === 'chat' ? state.pendingChat.shift() : null;
  const context = { isReset, plan };
  let text = runtimeTemplate(
    type === 'chat' ? state.settings.chatTemplate : state.settings.idleTemplate,
    item?.text || '',
    context,
  );
  if (isReset) {
    text += '\n\nA last-frame keyframe is supplied. Keep this as one continuous shot and converge naturally to that exact final visual state by the end.';
  }
  return { type, source: item, text, plan };
}

function shouldResetNow() {
  const every = Math.max(0, Number(state.settings.reanchorEvery || 0));
  return every > 0 && state.chainDepth >= every;
}

buildWorkflow = function (forceIdle = false) {
  const workflow = deepClone(state.workflow);
  const mapping = state.settings.mapping || {};
  const isReset = shouldResetNow();
  const promptInfo = choosePromptAndPlan(forceIdle, isReset);
  const canonical = state.settings.referenceImage || '';
  const firstFrame = state.continuityFrame || canonical;

  const staticOverrides = state.settings.staticOverrides || {};
  for (const [nodeId, inputs] of Object.entries(staticOverrides)) {
    for (const [inputName, value] of Object.entries(inputs || {})) {
      applyNodeInput(workflow, nodeId, inputName, value, false);
    }
  }

  const firstFrameNodeId = mapping.firstFrameNodeId || mapping.imageNodeId;
  const firstFrameInput = mapping.firstFrameInput || mapping.imageInput || 'image';
  if (firstFrame && firstFrameNodeId) {
    applyNodeInput(workflow, firstFrameNodeId, firstFrameInput, firstFrame, true);
  }

  if (canonical && mapping.lastFrameNodeId) {
    applyNodeInput(workflow, mapping.lastFrameNodeId, mapping.lastFrameInput || 'image', canonical, true);
  }

  const flNodeId = mapping.flNodeId || mapping.promptNodeId;
  const lastFrameInput = mapping.lastFrameTargetInput || 'last_frame';
  const flNode = workflow[String(flNodeId)];
  const exportedFlNode = state.workflow[String(flNodeId)];
  const exportedLastFrameConnection = exportedFlNode?.inputs?.[lastFrameInput];
  if (flNode?.inputs) {
    if (isReset) {
      if (!exportedLastFrameConnection) {
        throw new Error(`Reset is due, but ${flNodeId}.${lastFrameInput} was not connected in the exported API workflow.`);
      }
      flNode.inputs[lastFrameInput] = deepClone(exportedLastFrameConnection);
    } else {
      delete flNode.inputs[lastFrameInput];
    }
  }

  const lengthNodeId = mapping.lengthNodeId || mapping.promptNodeId;
  if (lengthNodeId) {
    applyNodeInput(workflow, lengthNodeId, mapping.lengthInput || 'length', promptInfo.plan.alignedFrames, false);
  }

  const useDirector = promptInfo.type === 'chat' && !!(mapping.llmInputTraceNodeId || mapping.directorNodeId);
  let directorText = '';
  if (useDirector) {
    const promptNode = workflow[String(mapping.promptNodeId)];
    const finalPromptInput = promptNode?.inputs?.[mapping.promptInput || 'prompt'];
    if (!Array.isArray(finalPromptInput)) {
      throw new Error(
        'LLM director is configured, but the H3 prompt input is not connected to another node in the exported workflow. ' +
        'Wire the director/formatter/trace chain into H3 before exporting API JSON.'
      );
    }

    const context = { isReset, plan: promptInfo.plan };
    directorText = runtimeTemplate(state.settings.directorTemplate || '', promptInfo.source?.text || '', context);
    if (isReset) {
      directorText += '\n\nThis is a continuity-reset segment: the model receives the current chain frame as first frame and the original canonical frame as last frame. Write the action/dialogue so the subject can respond while naturally returning to that final pose/composition.';
    }

    if (mapping.llmInputTraceNodeId) {
      applyNodeInput(workflow, mapping.llmInputTraceNodeId, mapping.traceInput || 'text', directorText, true);
      applyNodeInput(workflow, mapping.llmInputTraceNodeId, 'label', 'director_input', false);
    } else {
      applyNodeInput(workflow, mapping.directorNodeId, mapping.directorInput || 'text', directorText, true);
    }
  } else {
    applyNodeInput(workflow, mapping.promptNodeId, mapping.promptInput || 'prompt', promptInfo.text, true);
  }

  if (mapping.seedNodeId) {
    const seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    applyNodeInput(workflow, mapping.seedNodeId, mapping.seedInput || 'seed', seed, false);
  }

  return {
    workflow,
    promptInfo,
    useDirector,
    directorText,
    isReset,
    firstFrame,
    canonical,
  };
};

function historyTimes(record) {
  const result = {};
  const messages = record?.status?.messages || [];
  for (const entry of messages) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [name, payload] = entry;
    if (payload && Number.isFinite(Number(payload.timestamp))) result[name] = Number(payload.timestamp);
  }
  return result;
}

function extractTrace(record, nodeId) {
  if (!nodeId || !record?.outputs) return null;
  const output = record.outputs[String(nodeId)];
  if (!output) return null;
  const candidates = [];
  if (Array.isArray(output.trace)) candidates.push(...output.trace);
  if (Array.isArray(output.text)) candidates.push(...output.text);
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && 'text' in parsed) return parsed;
    } catch (_) {
      return { text: value, timestamp_ms: null, label: '' };
    }
  }
  return null;
}

async function waitForHistoryDetailed(promptId) {
  const started = Date.now();
  const timeoutMs = 45 * 60 * 1000;
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`/history/${encodeURIComponent(promptId)}`);
    if (res.ok) {
      const history = await res.json();
      const record = history[promptId] || history[String(promptId)];
      if (record) {
        const status = record.status;
        if (status && status.completed === true) {
          const media = extractMediaFromHistory(history, promptId);
          if (!media) throw new Error('Generation completed, but no media file was found in the selected output node.');
          return { media, record, history };
        }
        if (status && status.status_str === 'error') {
          throw new Error('ComfyUI reported an execution error. Check the ComfyUI console/history for node details.');
        }
      }
    }
    await sleep(500);
  }
  throw new Error('Timed out waiting for ComfyUI generation to finish');
}

async function probeMedia(media) {
  try {
    const res = await fetch('/live-h3-chat/api/probe-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media }),
    });
    const data = await res.json();
    return res.ok ? (data.probe || null) : { available: false, error: data.error || 'probe failed' };
  } catch (err) {
    return { available: false, error: err?.message || String(err) };
  }
}

async function extractContinuityFrame(media) {
  const res = await fetch('/live-h3-chat/api/extract-last-frame', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Could not extract final frame');
  return { filename: data.filename, probe: data.probe || null };
}

function renderDiagnostics() {
  const tbody = $('diagnosticsRows');
  if (!tbody) return;
  if (!state.diagnostics.length) {
    tbody.innerHTML = '<tr class="diagnostics-empty"><td colspan="11">No generated segments yet.</td></tr>';
    return;
  }
  tbody.innerHTML = state.diagnostics.slice().reverse().map((d) => {
    const typeBadge = `<span class="badge ${d.type === 'chat' ? 'chat' : ''}">${d.type}</span>`;
    const anchorBadge = d.isReset ? '<span class="badge reset">reset → canonical</span>' : '<span class="badge">chain</span>';
    const requested = `${d.plan.alignedFrames}f / ${fmtSeconds(d.plan.modelSeconds, 2)}`;
    const actual = d.probe?.available
      ? `${d.probe.frames ?? '?'}f / ${fmtSeconds(d.probe.duration, 2)} @ ${Number(d.probe.fps || 0).toFixed(2)}`
      : '—';
    const statusClass = d.status === 'discarded' ? 'discarded' : '';
    const output = d.media?.filename || '—';
    return `<tr>
      <td>${d.id}</td><td>${typeBadge}</td><td>${anchorBadge}</td><td>${requested}</td><td>${actual}</td>
      <td>${fmtMs(d.llmMs)}${d.llmEstimated ? ' ~' : ''}</td><td>${fmtMs(d.h3Ms)}</td><td>${fmtMs(d.workflowMs)}</td>
      <td title="${output}">${output}</td><td><span class="badge ${statusClass}">${d.status}</span></td>
      <td><button class="ghost diag-detail-btn" data-id="${d.id}">Details</button></td>
    </tr>`;
  }).join('');
}

function showDiagnosticDetail(id) {
  const d = state.diagnostics.find((x) => String(x.id) === String(id));
  if (!d) return;
  $('diagnosticsDetail')?.classList.remove('hidden');
  if ($('detailTitle')) $('detailTitle').textContent = `Segment #${d.id} — ${d.type}${d.isReset ? ' / reset' : ''}`;
  if ($('detailMeta')) $('detailMeta').textContent = `prompt_id=${d.promptId || '—'} | status=${d.status} | output=${d.media?.filename || '—'}`;
  if ($('detailDirectorInput')) $('detailDirectorInput').textContent = d.directorInput || '(not used for this segment)';
  if ($('detailLlmOutput')) $('detailLlmOutput').textContent = d.llmOutput || '(configure an LLM output trace node to capture this exactly)';
  if ($('detailH3Prompt')) $('detailH3Prompt').textContent = d.finalH3Prompt || '(configure a final H3 prompt trace node to capture this exactly)';
  if ($('detailContinuity')) {
    $('detailContinuity').textContent = JSON.stringify({
      first_frame: d.firstFrame,
      canonical_frame: d.canonical,
      extracted_end_frame: d.endFrame,
      reset: d.isReset,
      chain_depth_before: d.chainDepthBefore,
      chain_depth_after: d.chainDepthAfter,
      desired_seconds: d.plan.desiredSeconds,
      requested_frames: d.plan.requestedFrames,
      aligned_frames: d.plan.alignedFrames,
      model_seconds: d.plan.modelSeconds,
      media_probe: d.probe,
      browser_duration: d.browserDuration || null,
      execution: {
        llm_ms: d.llmMs,
        h3_and_downstream_ms: d.h3Ms,
        workflow_ms: d.workflowMs,
        pipeline_ms: d.pipelineMs,
      },
    }, null, 2);
  }
}

function registerDiagnostic(diag) {
  state.diagnostics.push(diag);
  if (state.diagnostics.length > 100) state.diagnostics.splice(0, state.diagnostics.length - 100);
  renderDiagnostics();
}

updateMetrics = function () {
  const buffered = bufferedSeconds();
  if ($('bufferBadge')) $('bufferBadge').textContent = `${buffered.toFixed(1)}s buffered`;
  if ($('queuedMetric')) $('queuedMetric').textContent = `${buffered.toFixed(1)}s`;
  if ($('generatingMetric')) $('generatingMetric').textContent = state.generating ? 'Yes' : 'No';
  if ($('playingMetric')) $('playingMetric').textContent = state.currentSegment ? `#${state.currentSegment.id}` : '—';
  if ($('chainMetric')) $('chainMetric').textContent = String(state.chainDepth || 0);
  if ($('continuityMetric')) $('continuityMetric').textContent = shortName(state.continuityFrame || state.settings.referenceImage);
  if ($('stageEmpty')) $('stageEmpty').style.display = state.currentSegment ? 'none' : 'block';
};

generateSegment = async function (forceIdle = false) {
  if (state.generating) return null;
  state.generating = true;
  state.generationStartedAt = performance.now();
  const epochAtStart = state.generationEpoch;
  const chainDepthBefore = state.chainDepth;
  updateMetrics();

  let built = null;
  let diag = null;
  try {
    built = buildWorkflow(forceIdle);
    state.currentGenerationMeta = { type: built.promptInfo.type, isReset: built.isReset, epoch: epochAtStart };
    setStatus(built.isReset ? 'Generating continuity reset…' : (built.promptInfo.type === 'chat' ? 'Generating chat response…' : 'Generating next segment…'), 'busy');

    const id = ++state.segmentCounter;
    diag = {
      id,
      type: built.promptInfo.type,
      isReset: built.isReset,
      status: 'running',
      promptId: null,
      plan: built.promptInfo.plan,
      firstFrame: built.firstFrame,
      canonical: built.canonical,
      endFrame: null,
      chainDepthBefore,
      chainDepthAfter: null,
      directorInput: built.directorText || '',
      llmOutput: '',
      finalH3Prompt: built.useDirector ? '' : built.promptInfo.text,
      llmMs: null,
      llmEstimated: false,
      h3Ms: null,
      workflowMs: null,
      pipelineMs: null,
      probe: null,
      media: null,
      createdAt: Date.now(),
    };

    const pipelineStart = performance.now();
    const promptId = await queuePrompt(built.workflow);
    diag.promptId = promptId;
    const { media, record } = await waitForHistoryDetailed(promptId);
    diag.media = media;

    const mapping = state.settings.mapping || {};
    const inputTrace = extractTrace(record, mapping.llmInputTraceNodeId);
    const outputTrace = extractTrace(record, mapping.llmOutputTraceNodeId);
    const finalTrace = extractTrace(record, mapping.finalPromptTraceNodeId);
    const times = historyTimes(record);
    const executionStart = times.execution_start || null;
    const executionEnd = times.execution_success || Date.now();

    if (outputTrace?.text) diag.llmOutput = outputTrace.text;
    if (finalTrace?.text) diag.finalH3Prompt = finalTrace.text;
    else if (built.useDirector && outputTrace?.text) diag.finalH3Prompt = outputTrace.text;

    if (built.useDirector && outputTrace?.timestamp_ms) {
      const llmStart = inputTrace?.timestamp_ms || executionStart;
      if (llmStart) {
        diag.llmMs = Math.max(0, outputTrace.timestamp_ms - llmStart);
        diag.llmEstimated = !inputTrace?.timestamp_ms;
      }
    }
    if (executionStart && executionEnd) diag.workflowMs = Math.max(0, executionEnd - executionStart);
    const h3Start = finalTrace?.timestamp_ms || outputTrace?.timestamp_ms;
    if (h3Start && executionEnd) diag.h3Ms = Math.max(0, executionEnd - h3Start);

    diag.probe = await probeMedia(media);
    const extracted = await extractContinuityFrame(media);
    diag.endFrame = extracted.filename;
    if ((!diag.probe || !diag.probe.available) && extracted.probe) diag.probe = extracted.probe;
    diag.pipelineMs = performance.now() - pipelineStart;

    const stale = epochAtStart !== state.generationEpoch;
    if (stale) {
      diag.status = 'discarded';
      diag.chainDepthAfter = state.chainDepth;
      registerDiagnostic(diag);
      addMessage('system', `Discarded segment #${id}; chat preempted the future idle chain while it was generating.`, 'system');
      return null;
    }

    const segment = {
      id,
      promptId,
      url: mediaUrl(media),
      media,
      promptType: built.promptInfo.type,
      chat: built.promptInfo.source,
      createdAt: Date.now(),
      modelSeconds: built.promptInfo.plan.modelSeconds,
      actualDuration: diag.probe?.duration || built.promptInfo.plan.modelSeconds,
      endFrame: diag.endFrame,
      firstFrame: built.firstFrame,
      isReset: built.isReset,
    };

    state.buffer.push(segment);
    state.continuityFrame = diag.endFrame;
    state.chainDepth = built.isReset ? 0 : (chainDepthBefore + 1);
    segment.chainDepthAfter = state.chainDepth;
    diag.chainDepthAfter = state.chainDepth;
    diag.status = 'ready';
    registerDiagnostic(diag);

    const elapsed = (performance.now() - state.generationStartedAt) / 1000;
    if ($('lastGenMetric')) $('lastGenMetric').textContent = `${elapsed.toFixed(1)}s`;
    addMessage(
      'system',
      `Generated segment #${id}${built.promptInfo.type === 'chat' ? ' for chat response' : ''}${built.isReset ? ' [reset]' : ''} (${media.filename}).`,
      'system',
    );
    prepareNextDeck();
    return segment;
  } catch (err) {
    if (diag) {
      diag.status = 'error';
      diag.error = err?.message || String(err);
      diag.pipelineMs = performance.now() - state.generationStartedAt;
      registerDiagnostic(diag);
    }
    throw err;
  } finally {
    state.generating = false;
    state.currentGenerationMeta = null;
    updateMetrics();
    if (state.running) setStatus('Live', 'live');
  }
};

function preemptIdleFutureForChat() {
  if (!state.running) return;
  const currentEnd = state.currentSegment?.endFrame;
  if (state.buffer.length) {
    const removed = state.buffer.length;
    state.buffer = [];
    const inactive = players[1 - state.activePlayer];
    resetPlayer(inactive);
    addMessage('system', `Chat preempted ${removed} buffered idle segment${removed === 1 ? '' : 's'} to preserve FL continuity.`, 'system');
  }

  if (currentEnd) {
    state.continuityFrame = currentEnd;
    state.chainDepth = Number(state.currentSegment?.chainDepthAfter ?? state.chainDepth ?? 0);
  } else {
    state.continuityFrame = state.settings.referenceImage || state.continuityFrame;
  }

  // If an idle segment is currently rendering from a now-discarded future frame,
  // let Comfy finish it but reject its result when it returns.
  if (state.generating && state.currentGenerationMeta?.type !== 'chat') {
    state.generationEpoch += 1;
  }
  updateMetrics();
}

maintainBufferLoop = async function () {
  while (state.running) {
    try {
      const targetSeconds = Math.max(0, Number(state.settings.targetBufferSeconds ?? 12));
      if (state.pendingChat.length && !state.generating) {
        await generateSegment(false);
      } else if (bufferedSeconds() < targetSeconds && !state.generating) {
        await generateSegment(false);
      } else {
        await sleep(250);
      }
    } catch (err) {
      handleError(err);
      await sleep(1200);
    }
  }
};

startLive = async function () {
  if (state.running) return;
  validateReady();
  state.running = true;
  state.prefilled = false;
  state.generationEpoch += 1;
  state.chainDepth = 0;
  state.continuityFrame = state.settings.referenceImage || '';
  state.buffer = [];
  state.currentSegment = null;
  $('startBtn').disabled = true;
  $('stopBtn').disabled = false;
  setStatus('Prefilling buffer…', 'busy');
  updateMetrics();

  const initialSeconds = Math.max(0, Number(state.settings.initialBufferSeconds ?? 10));
  try {
    while (state.running && bufferedSeconds() < initialSeconds) {
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
};

const _baseStopLive = stopLive;
stopLive = function () {
  state.generationEpoch += 1;
  _baseStopLive();
  state.continuityFrame = state.settings.referenceImage || '';
  state.chainDepth = 0;
  state.currentGenerationMeta = null;
  updateMetrics();
};

validateReady = function () {
  if (!state.workflow || !Object.keys(state.workflow).length) throw new Error('No API workflow is configured. Open Setup first.');
  const mapping = state.settings.mapping || {};
  if (!mapping.promptNodeId) throw new Error('H3 prompt / FL node ID is required.');
  if (!mapping.outputNodeId) throw new Error('Output video node ID is required.');
  if (!state.settings.referenceImage) throw new Error('A canonical/reset image is required for FL continuity.');
  if (!(mapping.firstFrameNodeId || mapping.imageNodeId)) throw new Error('First-frame Load Image node ID is required.');
  if (Number(state.settings.reanchorEvery || 0) > 0) {
    if (!mapping.lastFrameNodeId) throw new Error('Last-frame Load Image node ID is required when continuity reset is enabled.');
    const flNodeId = mapping.flNodeId || mapping.promptNodeId;
    const inputName = mapping.lastFrameTargetInput || 'last_frame';
    if (!state.workflow[String(flNodeId)]?.inputs?.[inputName]) {
      throw new Error(`Reset is enabled, but ${flNodeId}.${inputName} is not connected in the exported workflow.`);
    }
  }
};

// When a viewer sends chat, flush unplayed future clips before app.js enqueues
// the message. This preserves the FL chain while minimizing response latency.
$('chatForm')?.addEventListener('submit', (event) => {
  const text = $('chatInput')?.value.trim();
  if (text) preemptIdleFutureForChat();
}, true);

$('diagnosticsRows')?.addEventListener('click', (event) => {
  const btn = event.target.closest('.diag-detail-btn');
  if (btn) showDiagnosticDetail(btn.dataset.id);
});

$('closeDiagnosticsDetail')?.addEventListener('click', () => $('diagnosticsDetail')?.classList.add('hidden'));
$('clearDiagnosticsBtn')?.addEventListener('click', () => {
  state.diagnostics = [];
  $('diagnosticsDetail')?.classList.add('hidden');
  renderDiagnostics();
});

players.forEach((player) => {
  player.addEventListener('loadedmetadata', () => {
    const id = player.dataset.segmentId;
    if (!id || !Number.isFinite(player.duration)) return;
    const d = state.diagnostics.find((x) => String(x.id) === String(id));
    if (d) {
      d.browserDuration = player.duration;
      renderDiagnostics();
    }
  });
});

// The original app may have loaded config before this patch evaluated. Reload so
// all v2 temporal/FL/trace fields are populated.
loadConfig().then(() => {
  state.continuityFrame = state.settings.referenceImage || '';
  renderDiagnostics();
  updateMetrics();
}).catch(handleError);
