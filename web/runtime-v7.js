// Live H3 runtime v7: live render-quality controls.
//
// Exposes three workflow-native tuning surfaces on the main stage:
//   - ResolutionSelector.megapixels
//   - every discovered numeric `steps` input
//   - every configured rgthree Power Lora Loader lora_* slot
//
// Changes affect the next H3 video workflow only. The showrunner/vision preflight
// branches are intentionally untouched. Each completed segment records the exact
// tuning snapshot in diagnostics for practical A/B comparisons.

function v7NodeLabel(id, node) {
  return `${nodeTitle(node) || node?.class_type || 'node'} #${id}`;
}

function v7FindResolutionSelector(workflow) {
  let h3 = null;
  try {
    const roles = resolvedRoles(workflow);
    h3 = workflow[String(roles.h3)] || null;
  } catch (_) {}

  if (h3?.inputs) {
    const widthId = upstreamNodeId(h3, 'width');
    const heightId = upstreamNodeId(h3, 'height');
    if (widthId && widthId === heightId) {
      const node = workflow[String(widthId)];
      if (node?.inputs && typeof node.inputs.megapixels === 'number') {
        return { id: String(widthId), node };
      }
    }
  }

  const candidates = nodeEntries(workflow).filter(([, node]) =>
    typeof node.inputs?.megapixels === 'number' &&
    (/resolutionselector/i.test(String(node.class_type || '')) || /resolution selector/i.test(nodeTitle(node)))
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const aSize = /size/i.test(nodeTitle(a[1])) ? 1 : 0;
    const bSize = /size/i.test(nodeTitle(b[1])) ? 1 : 0;
    return bSize - aSize;
  });
  return { id: String(candidates[0][0]), node: candidates[0][1] };
}

function v7FindStepNodes(workflow) {
  return nodeEntries(workflow)
    .filter(([, node]) => typeof node.inputs?.steps === 'number' && Number.isFinite(node.inputs.steps))
    .map(([id, node]) => ({ id: String(id), node }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function v7IsPowerLoraNode(node) {
  const haystack = `${node?.class_type || ''} ${nodeTitle(node)}`.toLowerCase();
  return /power.*lora.*loader|lora.*power.*loader/.test(haystack);
}

function v7FindPowerLoraNodes(workflow) {
  return nodeEntries(workflow)
    .filter(([, node]) => v7IsPowerLoraNode(node))
    .map(([id, node]) => ({ id: String(id), node }))
    .filter(({ node }) => Object.keys(node.inputs || {}).some((key) => /^lora_/i.test(key)))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function v7DiscoverTuning(workflow = state.workflow) {
  return {
    resolution: v7FindResolutionSelector(workflow),
    steps: v7FindStepNodes(workflow),
    loras: v7FindPowerLoraNodes(workflow),
  };
}

function v7CloneLoraValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    on: value.on !== false,
    lora: String(value.lora || 'None'),
    strength: Number.isFinite(Number(value.strength)) ? Number(value.strength) : 1,
    ...(value.strengthTwo != null && Number.isFinite(Number(value.strengthTwo))
      ? { strengthTwo: Number(value.strengthTwo) }
      : {}),
  };
}

function v7SeedTuningFromWorkflow({ reset = false } = {}) {
  const discovery = v7DiscoverTuning(state.workflow);
  const saved = (!reset && state.settings?.liveRenderTuning && typeof state.settings.liveRenderTuning === 'object')
    ? deepClone(state.settings.liveRenderTuning)
    : {};
  const tuning = (!reset && state.liveRenderTuning && typeof state.liveRenderTuning === 'object')
    ? state.liveRenderTuning
    : saved;

  tuning.steps = tuning.steps || {};
  tuning.loras = tuning.loras || {};

  if (discovery.resolution && !Number.isFinite(Number(tuning.megapixels))) {
    tuning.megapixels = Number(discovery.resolution.node.inputs.megapixels);
  }

  for (const item of discovery.steps) {
    if (!Number.isFinite(Number(tuning.steps[item.id]))) {
      tuning.steps[item.id] = Number(item.node.inputs.steps);
    }
  }

  for (const item of discovery.loras) {
    tuning.loras[item.id] = tuning.loras[item.id] || {};
    for (const [slot, value] of Object.entries(item.node.inputs || {})) {
      if (!/^lora_/i.test(slot)) continue;
      if (!tuning.loras[item.id][slot]) {
        const cloned = v7CloneLoraValue(value);
        if (cloned) tuning.loras[item.id][slot] = cloned;
      }
    }
  }

  state.liveRenderTuning = tuning;
  state.settings.liveRenderTuning = deepClone(tuning);
  return { tuning, discovery };
}

function v7EscapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function v7SetLiveStatus(text, kind = 'ok') {
  const el = $('liveRenderTuningStatus');
  if (!el) return;
  el.textContent = text;
  el.className = `contract-status ${kind}`;
}

let v7LoraFiles = [];

async function v7LoadLoraFiles(force = false) {
  if (v7LoraFiles.length && !force) return v7LoraFiles;
  try {
    const res = await fetch('/live-h3-chat/api/loras');
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Could not list LoRAs');
    v7LoraFiles = Array.isArray(data.loras) ? data.loras : [];
  } catch (err) {
    v7LoraFiles = [];
    v7SetLiveStatus(`LoRA list unavailable: ${err?.message || err}`, 'warn');
  }
  return v7LoraFiles;
}

function v7LoraOptions(current) {
  const values = [...v7LoraFiles];
  if (current && current !== 'None' && !values.includes(current)) values.unshift(current);
  if (!values.includes('None')) values.unshift('None');
  return values.map((name) => `<option value="${v7EscapeHtml(name)}"${name === current ? ' selected' : ''}>${v7EscapeHtml(name)}</option>`).join('');
}

function v7RenderLiveControls() {
  const root = $('liveRenderControls');
  if (!root) return;
  const { tuning, discovery } = v7SeedTuningFromWorkflow();

  if (!state.workflow || !Object.keys(state.workflow).length) {
    root.innerHTML = '<div class="small mono">Adopt a workflow to discover render controls.</div>';
    v7SetLiveStatus('No workflow loaded.', 'warn');
    return;
  }

  const resolutionHtml = discovery.resolution
    ? `<label class="live-knob">
         <span>Output megapixels · ${v7EscapeHtml(v7NodeLabel(discovery.resolution.id, discovery.resolution.node))}</span>
         <input id="liveMegapixels" type="number" min="0.1" max="16" step="0.05" value="${Number(tuning.megapixels).toFixed(2)}" />
         <small>${v7EscapeHtml(String(discovery.resolution.node.inputs.aspect_ratio || ''))}</small>
       </label>`
    : '<div class="live-knob unavailable"><span>Output megapixels</span><strong>No ResolutionSelector found upstream of H3.</strong></div>';

  const stepsHtml = discovery.steps.length
    ? discovery.steps.map(({ id, node }) => `
        <label class="live-knob">
          <span>Steps · ${v7EscapeHtml(v7NodeLabel(id, node))}</span>
          <input class="live-step-input" data-node-id="${v7EscapeHtml(id)}" type="number" min="1" max="100" step="1" value="${Math.max(1, Math.round(Number(tuning.steps[id])))}" />
        </label>`).join('')
    : '<div class="live-knob unavailable"><span>Steps</span><strong>No numeric steps input found.</strong></div>';

  let loraHtml = '';
  if (!discovery.loras.length) {
    loraHtml = '<div class="small mono">No rgthree Power Lora Loader with configured lora_* slots was found.</div>';
  } else {
    loraHtml = discovery.loras.map(({ id, node }) => {
      const slots = Object.entries(tuning.loras[id] || {});
      return `
        <div class="live-lora-node">
          <div class="live-lora-node-title">${v7EscapeHtml(v7NodeLabel(id, node))}</div>
          ${slots.map(([slot, value]) => `
            <div class="live-lora-row" data-node-id="${v7EscapeHtml(id)}" data-slot="${v7EscapeHtml(slot)}">
              <label class="live-lora-toggle" title="${v7EscapeHtml(slot)}"><input class="live-lora-on" type="checkbox" ${value.on ? 'checked' : ''} /><span>${v7EscapeHtml(slot)}</span></label>
              <select class="live-lora-file">${v7LoraOptions(value.lora)}</select>
              <label class="live-lora-strength"><span>strength</span><input class="live-lora-strength-model" type="number" min="-10" max="10" step="0.05" value="${Number(value.strength)}" /></label>
              ${value.strengthTwo != null
                ? `<label class="live-lora-strength"><span>clip</span><input class="live-lora-strength-clip" type="number" min="-10" max="10" step="0.05" value="${Number(value.strengthTwo)}" /></label>`
                : ''}
            </div>`).join('')}
        </div>`;
    }).join('');
  }

  root.innerHTML = `
    <div class="live-knob-grid">${resolutionHtml}${stepsHtml}</div>
    <details class="live-lora-details" open>
      <summary>Power LoRA stack · models/loras/mmh3/</summary>
      <div id="liveLoraRows">${loraHtml}</div>
    </details>`;

  const resolutionCount = discovery.resolution ? 1 : 0;
  v7SetLiveStatus(`Ready · ${resolutionCount} resolution control · ${discovery.steps.length} step control${discovery.steps.length === 1 ? '' : 's'} · ${discovery.loras.length} Power LoRA loader${discovery.loras.length === 1 ? '' : 's'}. Changes apply to newly generated clips; already-buffered clips keep their old tuning.`, 'ok');
}

function v7CaptureLiveControls() {
  const { tuning } = v7SeedTuningFromWorkflow();
  const mp = Number($('liveMegapixels')?.value);
  if (Number.isFinite(mp)) tuning.megapixels = mp;

  document.querySelectorAll('.live-step-input').forEach((input) => {
    const value = Number(input.value);
    if (Number.isFinite(value)) tuning.steps[input.dataset.nodeId] = Math.max(1, Math.round(value));
  });

  document.querySelectorAll('.live-lora-row').forEach((row) => {
    const nodeId = row.dataset.nodeId;
    const slot = row.dataset.slot;
    tuning.loras[nodeId] = tuning.loras[nodeId] || {};
    const existing = tuning.loras[nodeId][slot] || {};
    const strength = Number(row.querySelector('.live-lora-strength-model')?.value);
    const clipInput = row.querySelector('.live-lora-strength-clip');
    const strengthTwo = clipInput ? Number(clipInput.value) : undefined;
    tuning.loras[nodeId][slot] = {
      ...existing,
      on: !!row.querySelector('.live-lora-on')?.checked,
      lora: row.querySelector('.live-lora-file')?.value || 'None',
      strength: Number.isFinite(strength) ? strength : 1,
      ...(clipInput && Number.isFinite(strengthTwo) ? { strengthTwo } : {}),
    };
  });

  state.liveRenderTuning = tuning;
  state.settings.liveRenderTuning = deepClone(tuning);
  v7SetLiveStatus('Live tuning updated. The next generated clip uses these values; buffered clips are unchanged. Save Setup if you want these values to survive a reload.', 'ok');
}

function v7ApplyTuning(workflow) {
  const tuning = state.liveRenderTuning || state.settings?.liveRenderTuning || {};
  const discovery = v7DiscoverTuning(workflow);
  const applied = {
    megapixels: null,
    resolutionNode: null,
    steps: [],
    loras: [],
  };

  if (discovery.resolution && Number.isFinite(Number(tuning.megapixels))) {
    discovery.resolution.node.inputs.megapixels = Number(tuning.megapixels);
    applied.megapixels = Number(tuning.megapixels);
    applied.resolutionNode = {
      id: discovery.resolution.id,
      title: nodeTitle(discovery.resolution.node),
      aspect_ratio: discovery.resolution.node.inputs.aspect_ratio || null,
      multiple: discovery.resolution.node.inputs.multiple || null,
    };
  }

  for (const item of discovery.steps) {
    const value = Number(tuning.steps?.[item.id]);
    if (!Number.isFinite(value)) continue;
    item.node.inputs.steps = Math.max(1, Math.round(value));
    applied.steps.push({ id: item.id, title: nodeTitle(item.node), class_type: item.node.class_type, steps: item.node.inputs.steps });
  }

  for (const item of discovery.loras) {
    const slots = tuning.loras?.[item.id] || {};
    for (const [slot, value] of Object.entries(slots)) {
      if (!(slot in item.node.inputs) || !/^lora_/i.test(slot)) continue;
      const normalized = v7CloneLoraValue(value);
      if (!normalized) continue;
      item.node.inputs[slot] = normalized;
      applied.loras.push({ node_id: item.id, node_title: nodeTitle(item.node), slot, ...deepClone(normalized) });
    }
  }

  return applied;
}

async function v7FlushFuture() {
  if (!state.running) {
    v7SetLiveStatus('Tuning is ready. Start the scene and newly generated clips will use it.', 'ok');
    return;
  }

  const removed = state.buffer.length;
  state.buffer = [];
  const inactive = players[1 - state.activePlayer];
  resetPlayer(inactive);

  if (state.currentSegment?.endFrame) {
    state.continuityFrame = state.currentSegment.endFrame;
    state.chainDepth = Number(state.currentSegment.chainDepthAfter ?? state.chainDepth ?? 0);
  } else {
    state.continuityFrame = state.settings.referenceImage || state.continuityFrame;
    state.chainDepth = 0;
  }

  const meta = state.currentGenerationMeta;
  if (state.generating && meta?.phase === 'video') {
    state.generationEpoch += 1;
    const token = meta.token || state.activeCancelToken;
    if (token) token.cancelled = true;
    await interruptPrompt(meta.promptId || token?.promptId);
  }

  updateMetrics();
  v7SetLiveStatus(`Flushed ${removed} unplayed clip${removed === 1 ? '' : 's'}. The next render starts from the current live continuity frame with the new tuning.`, 'warn');
}

setTimeout(() => {
  state.liveRenderTuning = state.liveRenderTuning || deepClone(state.settings?.liveRenderTuning || {});
  state._v7CurrentTuningSnapshot = null;

  const stage = document.querySelector('.stage-panel');
  const metrics = document.querySelector('.metrics-grid');
  if (stage && metrics && !$('liveRenderTuningCard')) {
    metrics.insertAdjacentHTML('afterend', `
      <div id="liveRenderTuningCard" class="v3-card live-render-card">
        <div class="section-head">
          <div><div class="eyebrow">Live render tuning</div><h3>Quality ↔ throughput</h3></div>
          <div class="controls-row compact">
            <button id="refreshLiveLorasBtn" class="ghost" type="button">Refresh LoRAs</button>
            <button id="flushTuningFutureBtn" type="button">Flush future</button>
          </div>
        </div>
        <div id="liveRenderTuningStatus" class="contract-status warn">Discovering workflow controls…</div>
        <div id="liveRenderControls"></div>
        <p class="small mono live-render-help">These controls override the cloned H3 video workflow only. They do not alter the LLM showrunner or vision bootstrap runs. Changes apply on generation, not to clips already sitting in the playback buffer.</p>
      </div>`);
  }

  const _v7FormToSettings = formToSettings;
  formToSettings = function () {
    const settings = _v7FormToSettings();
    settings.liveRenderTuning = deepClone(state.liveRenderTuning || state.settings?.liveRenderTuning || {});
    return settings;
  };

  const _v7SettingsToForm = settingsToForm;
  settingsToForm = function (settings) {
    _v7SettingsToForm(settings);
    state.liveRenderTuning = deepClone(settings.liveRenderTuning || {});
    setTimeout(() => {
      v7LoadLoraFiles().then(v7RenderLiveControls);
    }, 0);
  };

  // If a brand-new workflow is adopted, seed controls from that workflow rather
  // than carrying stale IDs/slots from the previous graph.
  if (typeof adoptWorkflowFromTextarea === 'function') {
    const _v7AdoptWorkflowFromTextarea = adoptWorkflowFromTextarea;
    adoptWorkflowFromTextarea = function () {
      const result = _v7AdoptWorkflowFromTextarea();
      state.liveRenderTuning = {};
      state.settings.liveRenderTuning = {};
      v7SeedTuningFromWorkflow({ reset: true });
      v7LoadLoraFiles(true).then(v7RenderLiveControls);
      return result;
    };
  }

  // Video-only override hook. This is downstream of the showrunner preflight, so
  // tuning sampler/LoRA/resolution never changes LLM cost or behavior.
  const _v7BuildVideoWorkflow = buildVideoWorkflowV3;
  buildVideoWorkflowV3 = function (intent, finalPrompt) {
    const built = _v7BuildVideoWorkflow(intent, finalPrompt);
    const applied = v7ApplyTuning(built.workflow);
    state._v7CurrentTuningSnapshot = deepClone(applied);
    built.liveRenderTuning = applied;
    return built;
  };

  const _v7GenerateSegment = generateSegment;
  generateSegment = async function (forceIdle = false) {
    state._v7CurrentTuningSnapshot = null;
    return _v7GenerateSegment(forceIdle);
  };

  const _v7RegisterDiagnostic = registerDiagnostic;
  registerDiagnostic = function (diag) {
    if (state._v7CurrentTuningSnapshot && !diag.renderTuning) {
      diag.renderTuning = deepClone(state._v7CurrentTuningSnapshot);
    }
    return _v7RegisterDiagnostic(diag);
  };

  const _v7ShowDiagnosticDetail = showDiagnosticDetail;
  showDiagnosticDetail = function (id) {
    _v7ShowDiagnosticDetail(id);
    const d = state.diagnostics.find((x) => String(x.id) === String(id));
    const target = $('detailContinuity');
    if (!d?.renderTuning || !target) return;
    try {
      const parsed = JSON.parse(target.textContent || '{}');
      parsed.render_tuning = d.renderTuning;
      target.textContent = JSON.stringify(parsed, null, 2);
    } catch (_) {}
  };

  $('liveRenderControls')?.addEventListener('change', v7CaptureLiveControls);
  $('refreshLiveLorasBtn')?.addEventListener('click', () => {
    v7LoadLoraFiles(true).then(v7RenderLiveControls);
  });
  $('flushTuningFutureBtn')?.addEventListener('click', () => v7FlushFuture().catch(handleError));
  $('workflowJson')?.addEventListener('input', () => setTimeout(v7RenderLiveControls, 0));

  v7LoadLoraFiles().then(v7RenderLiveControls);
}, 0);
