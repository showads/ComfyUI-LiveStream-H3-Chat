// Live H3 runtime v3
// App-owned workflow contract, structured two-phase showrunner, smart cancellation,
// adaptive stream governor, and non-repeating creative idle beats.

state.workflowContract = state.workflowContract || null;
state.recentBeats = state.recentBeats || [];
state.governor = state.governor || {
  ewmaRtf: null,
  samples: [],
  qualityScale: 1,
  effectiveTarget: null,
  health: 'learning',
};
state.activeCancelToken = null;

const LIVE_H3_PROFILE_ID = 'h3_fl2va_v3';
const SHOWRUNNER_OUTPUT_CLASS = 'LiveH3ShowrunnerOutput';
const SHOWRUNNER_OUTPUT_PREFIX = '__live_h3_showrunner_';
const DEFAULT_IDLE_BEATS = [
  'glance down and neatly straighten the papers or objects already on the surface',
  'briefly look toward the camera, then return attention to the work area',
  'look toward an off-camera monitor or cue and acknowledge it with a subtle expression',
  'make a small posture adjustment and settle naturally back into position',
  'pause as if listening to an earpiece or off-camera producer, then refocus',
  'move one existing paper or object into a neater position with a restrained gesture',
  'take a quiet breath, blink naturally, and maintain an attentive on-camera presence',
  'make a small note or reviewing gesture, then look back up calmly',
];

const DEFAULT_SHOWRUNNER_TEMPLATE = `You are the showrunner for a persistent MiniMax H3 FL2VA scene.
Return ONLY valid JSON. Do not use markdown fences.

TEMPORAL BUDGET
- clip_seconds: {segment_seconds}
- clip_frames: {segment_frames}
- fps: 24
All dialogue and visible action must comfortably fit inside that budget. Prefer a complete concise response with a brief natural pause at the end.

MODE: {showrunner_mode}
VIEWER MESSAGE: {chat_message}
SUGGESTED SCENE BEAT: {idle_beat}
RECENT CHAT:
{chat_history}

CONTINUITY
{reset_instruction}
The supplied first frame is the exact starting visual state. Preserve identity, wardrobe, lighting, set, camera position, and physical continuity.

SCENE DEFINITION
{base_prompt}

Return exactly this JSON shape:
{
  "dialogue": "exact literal words the on-screen subject should say, or an empty string for silence",
  "action": "concise physical action for this single continuous shot",
  "tone": "brief performance direction",
  "beat": "short label for what this moment accomplishes",
  "return_to_neutral": true,
  "estimated_spoken_seconds": 0
}`;

const DEFAULT_DIRECTED_H3_TEMPLATE = `{base_prompt}

detailed_description
Continue as one uninterrupted shot from the supplied first frame. {action}
Performance tone: {tone}.
{dialogue_instruction}
{reset_instruction}
{return_instruction}
The complete visible action and any dialogue must fit naturally within {segment_seconds} seconds ({segment_frames} frames at 24 fps).`;

function v3SetField(id, value) {
  const el = $(id);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value ?? '';
}

function v3GetField(id, fallback = '') {
  const el = $(id);
  if (!el) return fallback;
  if (el.type === 'checkbox') return el.checked;
  return el.value;
}

function v3Number(id, fallback) {
  const value = Number(v3GetField(id, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function nodeEntries(workflow) {
  return Object.entries(workflow || {}).filter(([, node]) => node && typeof node === 'object' && node.inputs);
}

function nodeTitle(node) {
  return String(node?._meta?.title || node?.title || '');
}

function isConnection(value) {
  return Array.isArray(value) && value.length >= 2 && (typeof value[0] === 'string' || typeof value[0] === 'number');
}

function upstreamNodeId(node, inputName) {
  const value = node?.inputs?.[inputName];
  return isConnection(value) ? String(value[0]) : null;
}

function selectorForNode(node) {
  const selector = {
    class_type: String(node?.class_type || ''),
  };
  const title = nodeTitle(node);
  if (title) selector.title = title;
  if (node?.class_type === 'LiveH3TraceText' && typeof node.inputs?.label === 'string') {
    selector.label = node.inputs.label;
  }
  selector.input_keys = Object.keys(node?.inputs || {}).sort();
  return selector;
}

function resolveSelector(workflow, selector) {
  if (!selector) return null;
  let matches = nodeEntries(workflow).filter(([, node]) => String(node.class_type || '') === String(selector.class_type || ''));
  if (selector.label) matches = matches.filter(([, node]) => String(node.inputs?.label || '') === selector.label);
  if (selector.title) {
    const titled = matches.filter(([, node]) => nodeTitle(node) === selector.title);
    if (titled.length) matches = titled;
  }
  if (selector.input_keys?.length && matches.length > 1) {
    const keyed = matches.filter(([, node]) => selector.input_keys.every((key) => key in (node.inputs || {})));
    if (keyed.length) matches = keyed;
  }
  return matches.length === 1 ? String(matches[0][0]) : (matches[0] ? String(matches[0][0]) : null);
}

function findTraceNode(workflow, label) {
  const match = nodeEntries(workflow).find(([, node]) => node.class_type === 'LiveH3TraceText' && String(node.inputs?.label || '') === label);
  return match ? { id: String(match[0]), node: match[1] } : null;
}

function referencedNodeIds(workflow) {
  const refs = new Set();
  for (const [, node] of nodeEntries(workflow)) {
    for (const value of Object.values(node.inputs || {})) {
      if (isConnection(value)) refs.add(String(value[0]));
    }
  }
  return refs;
}

function findVideoOutput(workflow) {
  const refs = referencedNodeIds(workflow);
  const scored = [];
  for (const [id, node] of nodeEntries(workflow)) {
    const cls = String(node.class_type || '');
    const title = nodeTitle(node);
    const text = `${cls} ${title}`.toLowerCase();
    let score = 0;
    if (/save.*video|video.*save|vhs.*video.*combine|video.*combine/.test(text)) score += 10;
    if (/video/.test(text)) score += 3;
    if (/save|combine/.test(text)) score += 3;
    if ('filename_prefix' in (node.inputs || {})) score += 2;
    if (!refs.has(String(id))) score += 4;
    if (score >= 7) scored.push({ id: String(id), node, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

function discoverWorkflowContract(workflow) {
  const errors = [];
  const warnings = [];
  const h3Matches = nodeEntries(workflow).filter(([, node]) =>
    node.class_type === 'MiniMaxH3ImageToVideo' ||
    (['prompt', 'length', 'first_frame', 'last_frame'].every((key) => key in (node.inputs || {})) && /minimax.*h3/i.test(String(node.class_type || '')))
  );
  if (!h3Matches.length) errors.push('MiniMaxH3ImageToVideo was not found.');
  if (h3Matches.length > 1) errors.push('More than one H3 Image-to-Video node was found; the profile expects one FL core.');

  const h3 = h3Matches[0] ? { id: String(h3Matches[0][0]), node: h3Matches[0][1] } : null;
  const firstId = h3 ? upstreamNodeId(h3.node, 'first_frame') : null;
  const lastId = h3 ? upstreamNodeId(h3.node, 'last_frame') : null;
  if (!firstId) errors.push('H3 first_frame must be connected to a Load Image node in the adopted workflow.');
  if (!lastId) errors.push('H3 last_frame must be connected to a canonical/reset Load Image node in the adopted workflow.');

  const directorInput = findTraceNode(workflow, 'director_input');
  const llmOutput = findTraceNode(workflow, 'llm_output');
  const finalPrompt = findTraceNode(workflow, 'final_h3_prompt');
  if (!directorInput) errors.push('Add a Live H3 Trace Text node labeled director_input immediately before the LLM.');
  if (!llmOutput) errors.push('Add a Live H3 Trace Text node labeled llm_output immediately after the LLM.');
  if (!finalPrompt) warnings.push('No final_h3_prompt trace found. v3 knows the final H3 prompt exactly, so this is optional.');

  const output = findVideoOutput(workflow);
  if (!output) errors.push('Could not identify a terminal video saver/output node.');

  const firstNode = firstId ? workflow[firstId] : null;
  const lastNode = lastId ? workflow[lastId] : null;
  if (firstNode && !/load.*image/i.test(String(firstNode.class_type || '') + ' ' + nodeTitle(firstNode))) {
    warnings.push(`first_frame source (${firstNode.class_type}) does not look like a Load Image node; dynamic continuity may not be patchable by filename.`);
  }
  if (lastNode && !/load.*image/i.test(String(lastNode.class_type || '') + ' ' + nodeTitle(lastNode))) {
    warnings.push(`last_frame source (${lastNode.class_type}) does not look like a Load Image node; canonical reset may not be patchable by filename.`);
  }

  const contract = {
    profile_id: LIVE_H3_PROFILE_ID,
    contract_version: 1,
    roles: {
      h3: h3 ? selectorForNode(h3.node) : null,
      first_frame_loader: firstNode ? selectorForNode(firstNode) : null,
      last_frame_loader: lastNode ? selectorForNode(lastNode) : null,
      director_input_trace: directorInput ? selectorForNode(directorInput.node) : null,
      llm_output_trace: llmOutput ? selectorForNode(llmOutput.node) : null,
      final_prompt_trace: finalPrompt ? selectorForNode(finalPrompt.node) : null,
      video_output: output ? selectorForNode(output.node) : null,
    },
    dynamic_inputs: {
      h3_prompt: 'prompt',
      h3_length: 'length',
      h3_first_frame: 'first_frame',
      h3_last_frame: 'last_frame',
      image_filename: 'image',
      trace_text: 'text',
      trace_label: 'label',
    },
    discovered: {
      h3_class: h3?.node?.class_type || null,
      output_class: output?.node?.class_type || null,
    },
  };
  return { contract, errors, warnings };
}

function resolveWorkflowContract(workflow, contract = state.workflowContract || state.settings?.workflowContract) {
  if (!contract?.roles) return { resolved: null, errors: ['No adopted workflow contract is saved.'] };
  const roles = {};
  const errors = [];
  for (const [name, selector] of Object.entries(contract.roles)) {
    if (!selector) continue;
    const id = resolveSelector(workflow, selector);
    if (id) roles[name] = id;
    else if (name !== 'final_prompt_trace') errors.push(`Could not resolve workflow role: ${name}`);
  }
  return { resolved: { ...roles, inputs: contract.dynamic_inputs || {} }, errors };
}

function contractSummary(discovery, resolved = null) {
  if (discovery?.errors?.length) return `Needs attention: ${discovery.errors.join(' ')}`;
  const roles = resolved?.resolved || {};
  const bits = [
    roles.h3 ? 'H3 ✓' : 'H3 ?',
    roles.first_frame_loader ? 'first ✓' : 'first ?',
    roles.last_frame_loader ? 'last ✓' : 'last ?',
    roles.director_input_trace ? 'director ✓' : 'director ?',
    roles.llm_output_trace ? 'LLM output ✓' : 'LLM output ?',
    roles.video_output ? 'video ✓' : 'video ?',
  ];
  return `MiniMax H3 FL2VA contract ready · ${bits.join(' · ')}`;
}

function refreshContractStatus() {
  const status = $('workflowContractStatus');
  const mappingGrid = document.querySelector('.mapping-grid');
  const workflowHelp = document.querySelector('.workflow-help');
  let workflow = state.workflow;
  try {
    const text = $('workflowJson')?.value;
    if (text?.trim()) workflow = JSON.parse(text);
  } catch (_) {}

  if (!workflow || !Object.keys(workflow).length) {
    if (status) {
      status.textContent = 'No workflow adopted yet. Paste an API workflow once, then click Adopt workflow.';
      status.className = 'contract-status warn';
    }
    if (mappingGrid) mappingGrid.style.display = '';
    return;
  }

  let contract = state.workflowContract || state.settings?.workflowContract;
  let discovery = null;
  if (!contract) {
    discovery = discoverWorkflowContract(workflow);
    if (!discovery.errors.length) contract = discovery.contract;
  }
  const resolved = contract ? resolveWorkflowContract(workflow, contract) : { resolved: null, errors: discovery?.errors || [] };
  const errors = [...(discovery?.errors || []), ...(resolved.errors || [])];
  const warnings = discovery?.warnings || [];
  if (status) {
    status.textContent = errors.length ? `Contract invalid: ${errors.join(' ')}` : contractSummary({ errors: [] }, resolved) + (warnings.length ? ` · ${warnings.join(' ')}` : '');
    status.className = `contract-status ${errors.length ? 'error' : 'ok'}`;
  }
  const ready = !errors.length && !!resolved.resolved;
  if (mappingGrid) mappingGrid.style.display = ready ? 'none' : '';
  if (workflowHelp) workflowHelp.style.display = ready ? 'none' : '';
  const rawLabel = $('workflowJson')?.closest('label');
  if (rawLabel && ready && !$('workflowRawVisible')?.checked) rawLabel.classList.add('workflow-raw-hidden');
}

function adoptWorkflowFromTextarea() {
  const workflow = parseMaybeJson($('workflowJson')?.value || '', {});
  const discovery = discoverWorkflowContract(workflow);
  if (discovery.errors.length) {
    state.workflowContract = null;
    refreshContractStatus();
    throw new Error(discovery.errors.join(' '));
  }
  state.workflow = workflow;
  state.workflowContract = discovery.contract;
  state.settings.workflowContract = discovery.contract;
  refreshContractStatus();
  addMessage('system', 'Adopted workflow as the app-owned H3 FL2VA contract. Node IDs will now be resolved semantically.', 'system');
  return discovery.contract;
}

function installV3UI() {
  const setup = document.querySelector('.setup-card');
  if (!setup || $('workflowContractStatus')) return;

  const metrics = document.querySelector('.metrics-grid');
  if (metrics) {
    metrics.insertAdjacentHTML('beforeend', `
      <div><span>RTF</span><strong id="rtfMetric">learning</strong></div>
      <div><span>Governor</span><strong id="governorMetric">balanced</strong></div>
    `);
  }

  const temporalNote = document.querySelector('.temporal-note');
  temporalNote?.insertAdjacentHTML('afterend', `
    <div class="v3-card">
      <div class="section-head"><div><div class="eyebrow">Adaptive stream governor</div><h3>Performance policy</h3></div></div>
      <div class="setup-grid">
        <label class="check-field"><span>Adaptive governor</span><input id="adaptiveGovernor" type="checkbox" checked /></label>
        <label class="check-field"><span>Smart-cancel obsolete idle work</span><input id="smartCancel" type="checkbox" checked /></label>
        <label><span>Latency ↔ quality (0–100)</span><input id="latencyQuality" type="range" min="0" max="100" step="1" value="65" /><output id="latencyQualityValue">65</output></label>
        <label><span>Cancel idle render before estimated progress</span><input id="cancelProgressThreshold" type="number" min="0.1" max="0.95" step="0.05" value="0.72" /></label>
      </div>
      <p class="small mono">RTF = video generation time ÷ generated video duration. The governor increases safety buffer when throughput tightens and can trim sampler steps only when RTF becomes unhealthy; it never raises steps above the adopted workflow baseline.</p>
    </div>
  `);

  const directorLabel = $('directorTemplate')?.closest('label');
  directorLabel?.insertAdjacentHTML('afterend', `
    <div class="v3-card">
      <div class="section-head"><div><div class="eyebrow">Structured showrunner</div><h3>Pre-production</h3></div></div>
      <label class="full"><span>Showrunner JSON prompt</span><textarea id="showrunnerTemplate" rows="14"></textarea></label>
      <label class="full"><span>Directed H3 formatter</span><textarea id="directedH3Template" rows="9"></textarea></label>
      <div class="setup-grid">
        <label><span>Proactive idle chance (0–1)</span><input id="proactiveChance" type="number" min="0" max="1" step="0.05" value="0.15" /></label>
        <label><span>Recent beats to avoid repeating</span><input id="beatMemory" type="number" min="1" max="20" step="1" value="4" /></label>
      </div>
      <label class="full"><span>Allowed idle beats (one per line)</span><textarea id="idleBeats" rows="8"></textarea></label>
      <p class="small mono">Chat always runs as a separate director preflight first. H3 then receives a deterministic prompt built from the structured JSON. Proactive idle uses the same showrunner occasionally; normal idle stays LLM-free.</p>
    </div>
  `);

  const workflowJsonLabel = $('workflowJson')?.closest('label');
  workflowJsonLabel?.insertAdjacentHTML('beforebegin', `
    <div class="v3-card workflow-contract-card">
      <div class="section-head">
        <div><div class="eyebrow">App-owned workflow</div><h3>H3 FL2VA contract</h3></div>
        <div class="controls-row compact"><button id="adoptWorkflowBtn" type="button">Adopt workflow</button></div>
      </div>
      <div id="workflowContractStatus" class="contract-status warn">Checking workflow…</div>
      <label class="inline-check"><input id="workflowRawVisible" type="checkbox" /> Show raw API workflow / legacy mappings</label>
      <p class="small mono">Import the API workflow once. The app stores semantic role selectors (H3, first/last frame loaders, trace labels, video output), not node IDs. Renumbering no longer requires manual remapping.</p>
    </div>
  `);

  $('adoptWorkflowBtn')?.addEventListener('click', () => {
    try { adoptWorkflowFromTextarea(); } catch (err) { handleError(err); }
  });
  $('workflowRawVisible')?.addEventListener('change', () => {
    const raw = $('workflowJson')?.closest('label');
    if (raw) raw.classList.toggle('workflow-raw-hidden', !$('workflowRawVisible').checked);
    const grid = document.querySelector('.mapping-grid');
    if (grid) grid.style.display = $('workflowRawVisible').checked ? '' : grid.style.display;
  });
  $('latencyQuality')?.addEventListener('input', () => {
    if ($('latencyQualityValue')) $('latencyQualityValue').textContent = $('latencyQuality').value;
  });
}

installV3UI();

const _v3BaseFormToSettings = formToSettings;
formToSettings = function () {
  const settings = _v3BaseFormToSettings();
  let workflow = {};
  try { workflow = parseMaybeJson($('workflowJson')?.value || '', {}); } catch (_) {}
  if (Object.keys(workflow).length) {
    const discovery = discoverWorkflowContract(workflow);
    if (!discovery.errors.length) state.workflowContract = discovery.contract;
  }
  settings.workflowContract = state.workflowContract || state.settings?.workflowContract || null;
  settings.adaptiveGovernor = !!v3GetField('adaptiveGovernor', true);
  settings.smartCancel = !!v3GetField('smartCancel', true);
  settings.latencyQuality = v3Number('latencyQuality', 65);
  settings.cancelProgressThreshold = v3Number('cancelProgressThreshold', 0.72);
  settings.showrunnerTemplate = v3GetField('showrunnerTemplate', DEFAULT_SHOWRUNNER_TEMPLATE);
  settings.directedH3Template = v3GetField('directedH3Template', DEFAULT_DIRECTED_H3_TEMPLATE);
  settings.proactiveChance = v3Number('proactiveChance', 0.15);
  settings.beatMemory = Math.max(1, Math.round(v3Number('beatMemory', 4)));
  settings.idleBeats = v3GetField('idleBeats', DEFAULT_IDLE_BEATS.join('\n'));
  return settings;
};

const _v3BaseSettingsToForm = settingsToForm;
settingsToForm = function (settings) {
  _v3BaseSettingsToForm(settings);
  state.workflowContract = settings.workflowContract || state.workflowContract || null;
  v3SetField('adaptiveGovernor', settings.adaptiveGovernor ?? true);
  v3SetField('smartCancel', settings.smartCancel ?? true);
  v3SetField('latencyQuality', settings.latencyQuality ?? 65);
  v3SetField('cancelProgressThreshold', settings.cancelProgressThreshold ?? 0.72);
  v3SetField('showrunnerTemplate', settings.showrunnerTemplate || DEFAULT_SHOWRUNNER_TEMPLATE);
  v3SetField('directedH3Template', settings.directedH3Template || DEFAULT_DIRECTED_H3_TEMPLATE);
  v3SetField('proactiveChance', settings.proactiveChance ?? 0.15);
  v3SetField('beatMemory', settings.beatMemory ?? 4);
  v3SetField('idleBeats', settings.idleBeats || DEFAULT_IDLE_BEATS.join('\n'));
  if ($('latencyQualityValue')) $('latencyQualityValue').textContent = String(settings.latencyQuality ?? 65);
  setTimeout(refreshContractStatus, 0);
};

function resolvedRoles(workflow = state.workflow) {
  const result = resolveWorkflowContract(workflow, state.workflowContract || state.settings?.workflowContract);
  if (result.errors.length) throw new Error(result.errors.join(' '));
  return result.resolved;
}

function parseBeats() {
  const raw = String(state.settings.idleBeats || DEFAULT_IDLE_BEATS.join('\n'));
  return raw.split(/\r?\n/).map((line) => line.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean);
}

function chooseIdleBeat() {
  const beats = parseBeats();
  if (!beats.length) return '';
  const memory = Math.max(1, Number(state.settings.beatMemory || 4));
  const recent = new Set(state.recentBeats.slice(-memory));
  let candidates = beats.filter((beat) => !recent.has(beat));
  if (!candidates.length) candidates = beats;
  const beat = candidates[Math.floor(Math.random() * candidates.length)];
  state.recentBeats.push(beat);
  if (state.recentBeats.length > 50) state.recentBeats.splice(0, state.recentBeats.length - 50);
  return beat;
}

function templateReplace(text, values) {
  let out = String(text || '');
  for (const [key, value] of Object.entries(values || {})) out = out.replaceAll(`{${key}}`, String(value ?? ''));
  return out;
}

function renderV3Template(template, ctx) {
  return templateReplace(renderTemplate(template || '', ctx.chatMessage || ''), {
    segment_seconds: ctx.plan.modelSeconds.toFixed(3),
    segment_frames: ctx.plan.alignedFrames,
    is_reset: ctx.isReset ? 'true' : 'false',
    reset_instruction: ctx.isReset
      ? 'A final-frame keyframe is supplied. The shot must move naturally from the current first frame and land precisely on the canonical last frame by the end.'
      : 'No final-frame keyframe is supplied; continue naturally from the exact supplied first frame.',
    showrunner_mode: ctx.mode || 'chat_response',
    idle_beat: ctx.beat || '',
  });
}

function governorThreshold() {
  const q = Math.max(0, Math.min(100, Number(state.settings.latencyQuality ?? 65))) / 100;
  return 0.72 + 0.18 * q;
}

function governorRecord(diag) {
  const duration = Number(diag.probe?.duration || diag.plan?.modelSeconds || 0);
  const videoMs = Number(diag.videoWorkflowMs || diag.h3Ms || 0);
  if (!(duration > 0) || !(videoMs > 0)) return;
  const rtf = videoMs / 1000 / duration;
  const g = state.governor;
  g.samples.push({ rtf, type: diag.type, duration, ms: videoMs, at: Date.now() });
  if (g.samples.length > 30) g.samples.splice(0, g.samples.length - 30);
  g.ewmaRtf = g.ewmaRtf == null ? rtf : (0.28 * rtf + 0.72 * g.ewmaRtf);
  g.health = g.ewmaRtf < 0.72 ? 'healthy' : (g.ewmaRtf < 0.98 ? 'tight' : 'behind');
  updateMetrics();
}

function estimatedVideoMs(type = 'idle') {
  const samples = state.governor.samples.filter((x) => x.type === type || (type === 'idle' && x.type === 'proactive_idle'));
  const use = samples.length ? samples : state.governor.samples;
  if (!use.length) return null;
  const recent = use.slice(-6).map((x) => x.ms).sort((a, b) => a - b);
  return recent[Math.floor(recent.length / 2)];
}

function effectiveTargetBufferSeconds() {
  const base = Math.max(0, Number(state.settings.targetBufferSeconds ?? 12));
  if (!state.settings.adaptiveGovernor || state.governor.ewmaRtf == null) return base;
  const rtf = state.governor.ewmaRtf;
  let extra = 0;
  if (rtf > 0.75) extra = Math.min(18, (rtf - 0.75) * 26);
  const q = Math.max(0, Math.min(100, Number(state.settings.latencyQuality ?? 65))) / 100;
  const target = Math.max(5, base + extra + q * 1.5);
  state.governor.effectiveTarget = target;
  return target;
}

function governorDesiredSeconds(type, baseSeconds) {
  if (!state.settings.adaptiveGovernor) return baseSeconds;
  const rtf = state.governor.ewmaRtf;
  const q = Math.max(0, Math.min(100, Number(state.settings.latencyQuality ?? 65))) / 100;
  if (type === 'chat') {
    if ((rtf != null && rtf > 0.95) || q < 0.3) return 5.0;
    if (rtf != null && rtf < 0.6 && q > 0.82) return Math.max(baseSeconds, 8.0);
  }
  if (type === 'idle' && rtf != null && rtf < 0.55 && q > 0.75) return Math.max(baseSeconds, 8.0);
  return baseSeconds;
}

function adaptiveQualityScale() {
  if (!state.settings.adaptiveGovernor || state.governor.ewmaRtf == null) return 1;
  const rtf = state.governor.ewmaRtf;
  const threshold = governorThreshold();
  if (rtf <= threshold) return 1;
  const severity = Math.min(1, (rtf - threshold) / 0.45);
  const q = Math.max(0, Math.min(100, Number(state.settings.latencyQuality ?? 65))) / 100;
  return Math.max(0.58, 1 - severity * (0.42 * (1 - q)));
}

function applyAdaptiveTunings(workflow) {
  const factor = adaptiveQualityScale();
  state.governor.qualityScale = factor;
  const changes = [];
  if (factor >= 0.999) return changes;
  for (const [id, node] of nodeEntries(workflow)) {
    const steps = node.inputs?.steps;
    if (typeof steps === 'number' && Number.isFinite(steps)) {
      const next = Math.max(4, Math.round(steps * factor));
      if (next < steps) {
        node.inputs.steps = next;
        changes.push({ node: id, class_type: node.class_type, input: 'steps', from: steps, to: next });
      }
    }
  }
  return changes;
}

function randomizeSeeds(workflow) {
  for (const [, node] of nodeEntries(workflow)) {
    for (const key of ['seed', 'noise_seed']) {
      if (typeof node.inputs?.[key] === 'number') node.inputs[key] = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    }
  }
}

function nextSyntheticNodeId(workflow) {
  let max = 0;
  for (const id of Object.keys(workflow || {})) if (/^\d+$/.test(id)) max = Math.max(max, Number(id));
  let candidate = max + 10000;
  while (workflow[String(candidate)]) candidate += 1;
  return String(candidate);
}

function pruneToTarget(workflow, targetId) {
  const keep = new Set();
  const visit = (id) => {
    id = String(id);
    if (keep.has(id) || !workflow[id]) return;
    keep.add(id);
    for (const value of Object.values(workflow[id].inputs || {})) if (isConnection(value)) visit(value[0]);
  };
  visit(targetId);
  const out = {};
  for (const id of keep) out[id] = workflow[id];
  return out;
}

async function queuePromptV3(workflow, { front = false } = {}) {
  const res = await fetch('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, front }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    const detail = data.node_errors ? JSON.stringify(data.node_errors) : (data.error || res.statusText);
    throw new Error(`ComfyUI rejected the prompt: ${detail}`);
  }
  if (!data.prompt_id) throw new Error('ComfyUI did not return a prompt_id');
  return data.prompt_id;
}

class LiveH3CancelledError extends Error {
  constructor(message = 'Generation cancelled') { super(message); this.name = 'LiveH3CancelledError'; }
}

async function waitForRecordV3(promptId, token, timeoutMs = 45 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (token?.cancelled) throw new LiveH3CancelledError();
    const res = await fetch(`/history/${encodeURIComponent(promptId)}`);
    if (res.ok) {
      const history = await res.json();
      const record = history[promptId] || history[String(promptId)];
      if (record) {
        const status = record.status;
        if (status?.completed === true) return { record, history };
        if (status?.status_str === 'error') throw new Error('ComfyUI reported an execution error. Check history/console for node details.');
      }
    }
    await sleep(300);
  }
  throw new Error('Timed out waiting for ComfyUI generation to finish');
}

async function interruptPrompt(promptId) {
  try {
    const res = await fetch('/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(promptId ? { prompt_id: promptId } : {}),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

function extractShowrunnerPayload(record, outputNodeId) {
  const output = record?.outputs?.[String(outputNodeId)] || {};
  const values = [];
  if (Array.isArray(output.showrunner)) values.push(...output.showrunner);
  if (Array.isArray(output.text)) values.push(...output.text);
  for (const value of values) {
    if (typeof value !== 'string') continue;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && 'text' in parsed) return parsed;
    } catch (_) {
      return { text: value, timestamp_ms: null };
    }
  }
  return null;
}

function parseShowrunnerJson(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(text);
    return {
      dialogue: String(parsed.dialogue || ''),
      action: String(parsed.action || 'Continue naturally from the starting frame with restrained, physically coherent movement.'),
      tone: String(parsed.tone || 'natural and conversational'),
      beat: String(parsed.beat || ''),
      return_to_neutral: parsed.return_to_neutral !== false,
      estimated_spoken_seconds: Number(parsed.estimated_spoken_seconds || 0) || 0,
      raw: parsed,
    };
  } catch (_) {
    return {
      dialogue: text,
      action: 'Continue naturally from the starting frame while delivering the line clearly.',
      tone: 'natural and conversational',
      beat: 'fallback',
      return_to_neutral: true,
      estimated_spoken_seconds: 0,
      raw: { parse_error: true, raw: text },
    };
  }
}

async function runShowrunner(intent, token) {
  const workflow = deepClone(state.workflow);
  const roles = resolvedRoles(workflow);
  if (!roles.director_input_trace || !roles.llm_output_trace) throw new Error('The adopted workflow is missing director_input or llm_output trace roles.');

  const directorPrompt = renderV3Template(state.settings.showrunnerTemplate || DEFAULT_SHOWRUNNER_TEMPLATE, {
    chatMessage: intent.source?.text || '',
    plan: intent.plan,
    isReset: intent.isReset,
    beat: intent.beat,
    mode: intent.type === 'chat' ? 'viewer_chat_response' : 'proactive_idle_beat',
  });

  applyNodeInput(workflow, roles.director_input_trace, 'text', directorPrompt, true);
  applyNodeInput(workflow, roles.director_input_trace, 'label', 'director_input', false);

  const outputId = nextSyntheticNodeId(workflow);
  workflow[outputId] = {
    class_type: SHOWRUNNER_OUTPUT_CLASS,
    inputs: { text: [String(roles.llm_output_trace), 0] },
    _meta: { title: 'Live H3 Showrunner Output (app injected)' },
  };
  const directorWorkflow = pruneToTarget(workflow, outputId);
  randomizeSeeds(directorWorkflow);

  state.currentGenerationMeta = {
    type: intent.type,
    phase: 'director',
    startedAt: performance.now(),
    token,
    promptId: null,
  };
  const queuedAt = performance.now();
  const promptId = await queuePromptV3(directorWorkflow, { front: intent.type === 'chat' });
  token.promptId = promptId;
  state.currentGenerationMeta.promptId = promptId;
  const { record } = await waitForRecordV3(promptId, token, 10 * 60 * 1000);
  const finishedAt = performance.now();
  const payload = extractShowrunnerPayload(record, outputId);
  if (!payload?.text) throw new Error('Showrunner completed but no text was captured.');

  const inputTrace = extractTrace(record, roles.director_input_trace);
  const outputTrace = extractTrace(record, roles.llm_output_trace);
  let llmMs = null;
  if (outputTrace?.timestamp_ms) {
    const startMs = inputTrace?.timestamp_ms || null;
    if (startMs) llmMs = Math.max(0, outputTrace.timestamp_ms - startMs);
  }
  if (llmMs == null) llmMs = finishedAt - queuedAt;

  return {
    directorPrompt,
    raw: payload.text,
    parsed: parseShowrunnerJson(payload.text),
    llmMs,
    promptId,
  };
}

function formatDirectedPrompt(intent, showrunner) {
  const values = {
    action: showrunner.action,
    tone: showrunner.tone,
    beat: showrunner.beat,
    dialogue: showrunner.dialogue,
    dialogue_instruction: showrunner.dialogue
      ? `The subject says clearly and literally: "${showrunner.dialogue.replaceAll('"', '\\"')}"`
      : 'No spoken dialogue occurs in this segment.',
    return_instruction: showrunner.return_to_neutral
      ? 'After the beat, settle into a calm neutral state that can continue naturally into the next clip.'
      : 'End in a physically stable state suitable for direct continuation into the next clip.',
  };
  return templateReplace(renderV3Template(state.settings.directedH3Template || DEFAULT_DIRECTED_H3_TEMPLATE, {
    chatMessage: intent.source?.text || '',
    plan: intent.plan,
    isReset: intent.isReset,
    beat: intent.beat,
    mode: intent.type,
  }), values);
}

function chooseV3Intent(forceIdle = false) {
  const isChat = !forceIdle && state.pendingChat.length > 0;
  const type = isChat ? 'chat' : 'idle';
  const source = isChat ? state.pendingChat.shift() : null;
  const isReset = shouldResetNow();
  const beat = type === 'idle' ? chooseIdleBeat() : '';
  const baseSeconds = isReset
    ? Number(state.settings.resetSeconds ?? 5.0)
    : (type === 'chat' ? Number(state.settings.chatSeconds ?? 7.3) : Number(state.settings.idleSeconds ?? 5.0));
  const desiredSeconds = governorDesiredSeconds(type, baseSeconds);
  const plan = h3FramePlan(desiredSeconds);
  const proactive = type === 'idle' && state.prefilled && Number(state.settings.proactiveChance || 0) > Math.random();
  return { type: proactive ? 'proactive_idle' : type, source, isReset, beat, plan, proactive };
}

function directIdlePrompt(intent) {
  let prompt = renderV3Template(state.settings.idleTemplate || '', {
    chatMessage: '', plan: intent.plan, isReset: intent.isReset, beat: intent.beat, mode: 'idle',
  });
  if (intent.beat) prompt += `\n\nCurrent idle beat: ${intent.beat}. Keep it subtle and physically continuous.`;
  if (intent.isReset) prompt += '\n\nUse the supplied last-frame keyframe as the exact visual landing point by the end of this continuous shot.';
  return prompt;
}

function buildVideoWorkflowV3(intent, finalPrompt) {
  const workflow = deepClone(state.workflow);
  const roles = resolvedRoles(workflow);
  const canonical = state.settings.referenceImage || '';
  const firstFrame = state.continuityFrame || canonical;

  const firstLoader = workflow[String(roles.first_frame_loader)];
  const lastLoader = workflow[String(roles.last_frame_loader)];
  if (!firstLoader?.inputs || !lastLoader?.inputs) throw new Error('Could not resolve dynamic first/last frame Load Image nodes.');
  const imageInputName = (state.workflowContract?.dynamic_inputs?.image_filename || 'image');
  firstLoader.inputs[imageInputName] = firstFrame;
  lastLoader.inputs[imageInputName] = canonical;

  const h3 = workflow[String(roles.h3)];
  if (!h3?.inputs) throw new Error('Could not resolve H3 FL node.');
  h3.inputs.prompt = finalPrompt;
  h3.inputs.length = intent.plan.alignedFrames;
  if (intent.isReset) {
    const exportedH3Id = resolveSelector(state.workflow, state.workflowContract.roles.h3);
    const originalLast = state.workflow[String(exportedH3Id)]?.inputs?.last_frame;
    if (!originalLast) throw new Error('Reset is due, but the adopted workflow does not contain an H3 last_frame connection.');
    h3.inputs.last_frame = deepClone(originalLast);
  } else {
    delete h3.inputs.last_frame;
  }

  // Legacy arbitrary overrides remain supported but are no longer part of the normal UI contract.
  for (const [nodeId, inputs] of Object.entries(state.settings.staticOverrides || {})) {
    if (!workflow[String(nodeId)]?.inputs) continue;
    for (const [key, value] of Object.entries(inputs || {})) workflow[String(nodeId)].inputs[key] = value;
  }

  randomizeSeeds(workflow);
  const tuningChanges = applyAdaptiveTunings(workflow);
  return { workflow, roles, firstFrame, canonical, tuningChanges };
}

extractMediaFromHistory = function (history, promptId) {
  const record = history[promptId] || history[String(promptId)];
  if (!record?.outputs) return null;
  let outputNodeId = null;
  try { outputNodeId = resolvedRoles(state.workflow).video_output; } catch (_) {}
  const outputs = outputNodeId ? [record.outputs[String(outputNodeId)], ...Object.values(record.outputs)] : Object.values(record.outputs);
  for (const output of outputs) {
    if (!output || typeof output !== 'object') continue;
    for (const value of Object.values(output)) {
      if (!Array.isArray(value)) continue;
      const found = value.find(looksLikeMediaRecord);
      if (found) return found;
    }
  }
  return null;
};

function v3StatusClass(status) {
  if (status === 'cancelled' || status === 'discarded') return 'discarded';
  return '';
}

renderDiagnostics = function () {
  const tbody = $('diagnosticsRows');
  if (!tbody) return;
  if (!state.diagnostics.length) {
    tbody.innerHTML = '<tr class="diagnostics-empty"><td colspan="11">No generated segments yet.</td></tr>';
    return;
  }
  tbody.innerHTML = state.diagnostics.slice().reverse().map((d) => {
    const displayType = d.type === 'proactive_idle' ? 'proactive' : d.type;
    const typeBadge = `<span class="badge ${d.type === 'chat' ? 'chat' : ''}">${displayType}</span>`;
    const anchorBadge = d.isReset ? '<span class="badge reset">reset → canonical</span>' : '<span class="badge">chain</span>';
    const requested = d.plan ? `${d.plan.alignedFrames}f / ${fmtSeconds(d.plan.modelSeconds, 2)}` : '—';
    const actual = d.probe?.available
      ? `${d.probe.frames ?? '?'}f / ${fmtSeconds(d.probe.duration, 2)} @ ${Number(d.probe.fps || 0).toFixed(2)}`
      : '—';
    const output = d.media?.filename || '—';
    return `<tr>
      <td>${d.id}</td><td>${typeBadge}</td><td>${anchorBadge}</td><td>${requested}</td><td>${actual}</td>
      <td>${fmtMs(d.llmMs)}</td><td>${fmtMs(d.videoWorkflowMs || d.h3Ms)}</td><td>${fmtMs(d.pipelineMs || d.workflowMs)}</td>
      <td title="${output}">${output}</td><td><span class="badge ${v3StatusClass(d.status)}">${d.status}</span></td>
      <td><button class="ghost diag-detail-btn" data-id="${d.id}">Details</button></td>
    </tr>`;
  }).join('');
};

showDiagnosticDetail = function (id) {
  const d = state.diagnostics.find((x) => String(x.id) === String(id));
  if (!d) return;
  $('diagnosticsDetail')?.classList.remove('hidden');
  if ($('detailTitle')) $('detailTitle').textContent = `Segment #${d.id} — ${d.type}${d.isReset ? ' / reset' : ''}`;
  if ($('detailMeta')) $('detailMeta').textContent = `video_prompt_id=${d.promptId || '—'} | director_prompt_id=${d.directorPromptId || '—'} | status=${d.status}`;
  if ($('detailDirectorInput')) $('detailDirectorInput').textContent = d.directorInput || '(LLM not used)';
  if ($('detailLlmOutput')) $('detailLlmOutput').textContent = d.llmOutput || '(LLM not used)';
  if ($('detailH3Prompt')) $('detailH3Prompt').textContent = d.finalH3Prompt || '';
  if ($('detailContinuity')) $('detailContinuity').textContent = JSON.stringify({
    workflow_contract: state.workflowContract?.profile_id || null,
    first_frame: d.firstFrame,
    canonical_frame: d.canonical,
    extracted_end_frame: d.endFrame,
    reset: d.isReset,
    beat: d.beat,
    showrunner: d.showrunnerParsed || null,
    chain_depth_before: d.chainDepthBefore,
    chain_depth_after: d.chainDepthAfter,
    desired_seconds: d.plan?.desiredSeconds,
    requested_frames: d.plan?.requestedFrames,
    aligned_frames: d.plan?.alignedFrames,
    media_probe: d.probe,
    browser_duration: d.browserDuration || null,
    governor: {
      rtf_after_segment: d.rtf,
      quality_scale: d.qualityScale,
      adaptive_changes: d.tuningChanges || [],
      effective_target_seconds: d.effectiveTargetSeconds,
    },
    execution: {
      llm_ms: d.llmMs,
      video_workflow_ms: d.videoWorkflowMs,
      pipeline_ms: d.pipelineMs,
    },
    error: d.error || null,
  }, null, 2);
};

const _v3OldUpdateMetrics = updateMetrics;
updateMetrics = function () {
  _v3OldUpdateMetrics();
  const rtf = state.governor.ewmaRtf;
  if ($('rtfMetric')) $('rtfMetric').textContent = rtf == null ? 'learning' : `${rtf.toFixed(2)}× ${state.governor.health}`;
  if ($('governorMetric')) {
    const target = effectiveTargetBufferSeconds();
    const scale = state.governor.qualityScale || 1;
    $('governorMetric').textContent = `${target.toFixed(1)}s · ${(scale * 100).toFixed(0)}% steps`;
  }
};

async function generateSegmentV3(forceIdle = false) {
  if (state.generating) return null;
  state.generating = true;
  const generationStarted = performance.now();
  const epochAtStart = state.generationEpoch;
  const chainDepthBefore = state.chainDepth;
  const token = { cancelled: false, promptId: null };
  state.activeCancelToken = token;
  updateMetrics();

  const id = ++state.segmentCounter;
  let intent = null;
  let diag = null;
  try {
    intent = chooseV3Intent(forceIdle);
    diag = {
      id,
      type: intent.type,
      isReset: intent.isReset,
      beat: intent.beat,
      status: 'running',
      plan: intent.plan,
      promptId: null,
      directorPromptId: null,
      directorInput: '',
      llmOutput: '',
      showrunnerParsed: null,
      finalH3Prompt: '',
      llmMs: null,
      videoWorkflowMs: null,
      pipelineMs: null,
      probe: null,
      media: null,
      firstFrame: state.continuityFrame || state.settings.referenceImage || '',
      canonical: state.settings.referenceImage || '',
      endFrame: null,
      chainDepthBefore,
      chainDepthAfter: null,
      tuningChanges: [],
      qualityScale: 1,
      effectiveTargetSeconds: effectiveTargetBufferSeconds(),
      createdAt: Date.now(),
    };

    let finalPrompt = '';
    const needsDirector = intent.type === 'chat' || intent.proactive;
    if (needsDirector) {
      setStatus(intent.type === 'chat' ? 'Showrunner writing response…' : 'Showrunner planning idle beat…', 'busy');
      const show = await runShowrunner(intent, token);
      diag.directorInput = show.directorPrompt;
      diag.llmOutput = show.raw;
      diag.showrunnerParsed = show.parsed.raw;
      diag.llmMs = show.llmMs;
      diag.directorPromptId = show.promptId;
      finalPrompt = formatDirectedPrompt(intent, show.parsed);
    } else {
      finalPrompt = directIdlePrompt(intent);
    }
    diag.finalH3Prompt = finalPrompt;

    if (token.cancelled) throw new LiveH3CancelledError();
    const built = buildVideoWorkflowV3(intent, finalPrompt);
    diag.firstFrame = built.firstFrame;
    diag.canonical = built.canonical;
    diag.tuningChanges = built.tuningChanges;
    diag.qualityScale = state.governor.qualityScale;

    state.currentGenerationMeta = {
      type: intent.type,
      phase: 'video',
      startedAt: performance.now(),
      token,
      promptId: null,
      predictedMs: estimatedVideoMs(intent.type === 'chat' ? 'chat' : 'idle'),
    };
    setStatus(intent.isReset ? 'Generating continuity reset…' : (intent.type === 'chat' ? 'Generating chat video…' : 'Generating next segment…'), 'busy');
    const videoStarted = performance.now();
    const promptId = await queuePromptV3(built.workflow, { front: intent.type === 'chat' });
    token.promptId = promptId;
    state.currentGenerationMeta.promptId = promptId;
    diag.promptId = promptId;
    const { record, history } = await waitForRecordV3(promptId, token);
    diag.videoWorkflowMs = performance.now() - videoStarted;

    const media = extractMediaFromHistory(history, promptId);
    if (!media) throw new Error('Video workflow completed, but no media file was found in the discovered output node.');
    diag.media = media;
    diag.probe = await probeMedia(media);
    const extracted = await extractContinuityFrame(media);
    diag.endFrame = extracted.filename;
    if ((!diag.probe || !diag.probe.available) && extracted.probe) diag.probe = extracted.probe;
    diag.pipelineMs = performance.now() - generationStarted;

    const stale = epochAtStart !== state.generationEpoch;
    if (stale) {
      diag.status = 'discarded';
      diag.chainDepthAfter = state.chainDepth;
      registerDiagnostic(diag);
      addMessage('system', `Discarded segment #${id}; its FL future was preempted by newer chat.`, 'system');
      return null;
    }

    const segment = {
      id,
      promptId,
      url: mediaUrl(media),
      media,
      promptType: intent.type,
      chat: intent.source,
      createdAt: Date.now(),
      modelSeconds: intent.plan.modelSeconds,
      actualDuration: diag.probe?.duration || intent.plan.modelSeconds,
      endFrame: diag.endFrame,
      firstFrame: built.firstFrame,
      isReset: intent.isReset,
    };
    state.buffer.push(segment);
    state.continuityFrame = diag.endFrame;
    state.chainDepth = intent.isReset ? 0 : (chainDepthBefore + 1);
    segment.chainDepthAfter = state.chainDepth;
    diag.chainDepthAfter = state.chainDepth;
    diag.status = 'ready';
    governorRecord(diag);
    diag.rtf = state.governor.ewmaRtf;
    diag.effectiveTargetSeconds = effectiveTargetBufferSeconds();
    registerDiagnostic(diag);

    if ($('lastGenMetric')) $('lastGenMetric').textContent = `${((performance.now() - generationStarted) / 1000).toFixed(1)}s`;
    addMessage('system', `Generated segment #${id}${intent.type === 'chat' ? ' for chat' : intent.type === 'proactive_idle' ? ' [proactive]' : ''}${intent.isReset ? ' [reset]' : ''} (${media.filename}).`, 'system');
    prepareNextDeck();
    return segment;
  } catch (err) {
    if (err instanceof LiveH3CancelledError) {
      if (intent?.source) state.pendingChat.unshift(intent.source);
      if (diag) {
        diag.status = 'cancelled';
        diag.pipelineMs = performance.now() - generationStarted;
        diag.chainDepthAfter = state.chainDepth;
        registerDiagnostic(diag);
      }
      addMessage('system', `Cancelled obsolete ${intent?.type || 'idle'} work so newer chat can run first.`, 'system');
      return null;
    }
    if (intent?.source && intent.type === 'chat') state.pendingChat.unshift(intent.source);
    if (diag) {
      diag.status = 'error';
      diag.error = err?.message || String(err);
      diag.pipelineMs = performance.now() - generationStarted;
      registerDiagnostic(diag);
    }
    throw err;
  } finally {
    state.generating = false;
    state.currentGenerationMeta = null;
    if (state.activeCancelToken === token) state.activeCancelToken = null;
    updateMetrics();
    if (state.running) setStatus('Live', 'live');
  }
}

generateSegment = generateSegmentV3;

preemptIdleFutureForChat = function () {
  if (!state.running) return;
  const currentEnd = state.currentSegment?.endFrame;
  if (state.buffer.length) {
    const removed = state.buffer.length;
    state.buffer = [];
    const inactive = players[1 - state.activePlayer];
    resetPlayer(inactive);
    addMessage('system', `Chat flushed ${removed} unplayed FL future segment${removed === 1 ? '' : 's'}.`, 'system');
  }

  if (currentEnd) {
    state.continuityFrame = currentEnd;
    state.chainDepth = Number(state.currentSegment?.chainDepthAfter ?? state.chainDepth ?? 0);
  } else {
    state.continuityFrame = state.settings.referenceImage || state.continuityFrame;
    state.chainDepth = 0;
  }

  const meta = state.currentGenerationMeta;
  if (state.generating && meta && meta.type !== 'chat') {
    state.generationEpoch += 1;
    const token = meta.token || state.activeCancelToken;
    const smartCancel = state.settings.smartCancel !== false;
    let shouldCancel = meta.phase === 'director';
    if (meta.phase === 'video') {
      const elapsed = performance.now() - meta.startedAt;
      const predicted = meta.predictedMs || estimatedVideoMs('idle');
      const progress = predicted ? elapsed / predicted : 0;
      const threshold = Number(state.settings.cancelProgressThreshold ?? 0.72);
      shouldCancel = !predicted || progress < threshold;
    }
    if (smartCancel && shouldCancel && token) {
      token.cancelled = true;
      interruptPrompt(meta.promptId || token.promptId).then((ok) => {
        addMessage('system', ok ? 'Interrupted obsolete ComfyUI generation.' : 'Marked obsolete generation for discard; interrupt request was unavailable.', 'system');
      });
    }
  }
  updateMetrics();
};

maintainBufferLoop = async function () {
  while (state.running) {
    try {
      const targetSeconds = effectiveTargetBufferSeconds();
      if (state.pendingChat.length && !state.generating) await generateSegment(false);
      else if (bufferedSeconds() < targetSeconds && !state.generating) await generateSegment(false);
      else await sleep(200);
    } catch (err) {
      handleError(err);
      await sleep(1000);
    }
  }
};

validateReady = function () {
  if (!state.workflow || !Object.keys(state.workflow).length) throw new Error('No app-owned API workflow is configured. Open Setup and adopt a workflow.');
  if (!state.settings.referenceImage) throw new Error('A canonical/reset image is required.');
  const contract = state.workflowContract || state.settings.workflowContract;
  if (!contract) throw new Error('The workflow has not been adopted into the H3 FL2VA contract yet.');
  const resolved = resolveWorkflowContract(state.workflow, contract);
  if (resolved.errors.length) throw new Error(`Workflow contract no longer resolves: ${resolved.errors.join(' ')}`);
  const h3 = state.workflow[String(resolved.resolved.h3)];
  if (!h3?.inputs?.first_frame || !h3?.inputs?.last_frame) throw new Error('Adopted H3 node must have both first_frame and last_frame connected in the canonical workflow.');
};

const _v3OldStartLive = startLive;
startLive = async function () {
  state.recentBeats = [];
  state.governor = { ewmaRtf: null, samples: [], qualityScale: 1, effectiveTarget: null, health: 'learning' };
  return _v3OldStartLive();
};

const _v3OldStopLive = stopLive;
stopLive = function () {
  if (state.activeCancelToken) state.activeCancelToken.cancelled = true;
  _v3OldStopLive();
};

// Keep contract synchronized whenever the raw workflow changes.
$('workflowJson')?.addEventListener('input', () => {
  state.workflowContract = null;
  refreshContractStatus();
});

// Reload after v3 UI/settings hooks are installed.
loadConfig().then(() => {
  if (!state.workflowContract && state.workflow && Object.keys(state.workflow).length) {
    const discovery = discoverWorkflowContract(state.workflow);
    if (!discovery.errors.length) {
      state.workflowContract = discovery.contract;
      state.settings.workflowContract = discovery.contract;
    }
  }
  refreshContractStatus();
  updateMetrics();
}).catch(handleError);
