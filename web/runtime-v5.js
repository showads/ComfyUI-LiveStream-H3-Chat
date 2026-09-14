// Live H3 runtime v5: canonical-image vision bootstrap.
//
// Optional workflow wiring:
//   canonical Load Image ───────────────┐
//                                      ▼
//   LiveH3TraceText                    image+text vision LLM
//     label=scene_bootstrap_input  ───►│
//                                      ▼
//   LiveH3TraceText label=scene_bootstrap_output
//
// The app runs only that dependency branch as a one-time preflight, captures the
// vision model's result, and can populate the stable scene/base prompt + idle
// beat library. It does not add vision-model latency to normal video segments.

const DEFAULT_SCENE_BOOTSTRAP_TEMPLATE = `Analyze the supplied canonical still image and write the stable scene scaffolding for an ongoing MiniMax H3 video stream.

Return ONLY valid JSON. Do not use markdown fences.

Your job is to describe what must remain stable across many future video clips. Do NOT write a detailed_description, shot action, dialogue, or temporary movement. Those are added later per segment.

Use the visible image as the source of truth. Be concrete about identity-preserving visible traits, wardrobe, pose/framing, camera, lighting, set/environment, and recurring objects. Do not invent details that are not visually supported.

The base_prompt value must itself be valid MiniMax-style prompt scaffolding with these sections in this order:

subject_definitions
<Subject 1> ...
<Picture 1> the supplied canonical reference still used as the primary visual anchor ...

summary
...

retention_analysis
<Subject 1> (appears in Shot 1): fully_preserved - ...
<Picture 1> (appears in Shot 1): fully_preserved - ...

overall_soundscape
...

non_diegetic_music
None.

Also suggest several subtle silent idle actions that are plausible from this exact setup. Each idle beat should be a single short physical direction suitable for appending directly to an H3 idle prompt.

Return exactly this JSON shape:
{
  "scene_name": "short descriptive name",
  "base_prompt": "complete stable prompt scaffolding, with newlines escaped correctly for JSON",
  "idle_beats": ["short idle direction", "short idle direction"],
  "notes": "optional short observation about anything uncertain or important"
}`;

function parseSceneBootstrapOutput(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return {
        sceneName: String(parsed.scene_name || ''),
        basePrompt: String(parsed.base_prompt || ''),
        idleBeats: Array.isArray(parsed.idle_beats) ? parsed.idle_beats.map((x) => String(x).trim()).filter(Boolean) : [],
        notes: String(parsed.notes || ''),
        raw: parsed,
        parseError: false,
      };
    }
  } catch (_) {}

  // Useful fallback for vision/text nodes that ignore the JSON instruction: use
  // their entire response as the base prompt rather than throwing it away.
  return {
    sceneName: '',
    basePrompt: text,
    idleBeats: [],
    notes: 'Vision output was not valid bootstrap JSON; raw text was used as the base prompt.',
    raw: { parse_error: true, raw: text },
    parseError: true,
  };
}

function v5DependsOnNode(workflow, targetId, ancestorId, seen = new Set()) {
  targetId = String(targetId || '');
  ancestorId = String(ancestorId || '');
  if (!targetId || !ancestorId || seen.has(targetId)) return false;
  if (targetId === ancestorId) return true;
  seen.add(targetId);
  const node = workflow?.[targetId];
  if (!node?.inputs) return false;
  for (const value of Object.values(node.inputs)) {
    if (!isConnection(value)) continue;
    const upstream = String(value[0]);
    if (upstream === ancestorId || v5DependsOnNode(workflow, upstream, ancestorId, seen)) return true;
  }
  return false;
}

function discoverSceneBootstrap(workflow) {
  const input = findTraceNode(workflow, 'scene_bootstrap_input');
  const output = findTraceNode(workflow, 'scene_bootstrap_output');
  const errors = [];
  const warnings = [];

  if (!input || !output) {
    if (!input) errors.push('missing Live H3 Trace Text label scene_bootstrap_input');
    if (!output) errors.push('missing Live H3 Trace Text label scene_bootstrap_output');
    return { input, output, errors, warnings };
  }

  if (!v5DependsOnNode(workflow, output.id, input.id)) {
    errors.push(`scene_bootstrap_output (#${output.id}) is not downstream of scene_bootstrap_input (#${input.id})`);
  }

  try {
    const roles = resolvedRoles(workflow);
    if (roles.first_frame_loader && !v5DependsOnNode(workflow, output.id, roles.first_frame_loader)) {
      warnings.push(`bootstrap output does not depend on the canonical first-frame loader (#${roles.first_frame_loader}); make sure the vision node actually receives the canonical image`);
    }
  } catch (_) {}

  return { input, output, errors, warnings };
}

setTimeout(() => {
  state.sceneBootstrap = state.sceneBootstrap || {
    running: false,
    promptId: null,
    input: '',
    output: '',
    parsed: null,
    elapsedMs: null,
  };

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------
  const uploadRow = $('referenceFile')?.closest('.upload-row');
  if (uploadRow && !$('sceneBootstrapCard')) {
    uploadRow.insertAdjacentHTML('afterend', `
      <div id="sceneBootstrapCard" class="v3-card">
        <div class="section-head">
          <div>
            <div class="eyebrow">Vision scene bootstrap</div>
            <h3>Generate stable H3 scaffolding from the canonical image</h3>
          </div>
          <div class="controls-row compact">
            <button id="runSceneBootstrapBtn" type="button">Analyze image + update scene</button>
          </div>
        </div>
        <div id="sceneBootstrapStatus" class="contract-status warn">Optional: wire the two scene_bootstrap trace nodes around your image+text vision node.</div>
        <label class="full">
          <span>Vision bootstrap prompt</span>
          <textarea id="sceneBootstrapTemplate" rows="14"></textarea>
        </label>
        <details id="sceneBootstrapDetails" class="full">
          <summary>Last vision-bootstrap trace</summary>
          <div class="trace-grid">
            <div class="trace-wide"><div class="trace-label">Vision input prompt</div><pre id="sceneBootstrapInputTrace">No bootstrap run yet.</pre></div>
            <div class="trace-wide"><div class="trace-label">Vision output</div><pre id="sceneBootstrapOutputTrace">No bootstrap run yet.</pre></div>
          </div>
        </details>
        <p class="small mono">
          Recommended wiring: canonical Load Image → vision node image input; Live H3 Trace Text
          <strong>scene_bootstrap_input</strong> → vision node text input → Live H3 Trace Text
          <strong>scene_bootstrap_output</strong>. This runs only when you press the button, not per video segment.
        </p>
      </div>
    `);
  }

  function sceneBootstrapStatus() {
    const el = $('sceneBootstrapStatus');
    if (!el) return;
    let workflow = state.workflow;
    try {
      const raw = $('workflowJson')?.value;
      if (raw?.trim()) workflow = JSON.parse(raw);
    } catch (_) {}

    if (!workflow || !Object.keys(workflow).length) {
      el.textContent = 'Load/adopt a workflow first.';
      el.className = 'contract-status warn';
      return;
    }

    const found = discoverSceneBootstrap(workflow);
    if (found.errors.length) {
      el.textContent = `Vision bootstrap not ready: ${found.errors.join('; ')}.`;
      el.className = 'contract-status warn';
      return;
    }

    const warning = found.warnings.length ? ` · ${found.warnings.join('; ')}` : '';
    el.textContent = `Vision bootstrap ready · input #${found.input.id} · output #${found.output.id}${warning}`;
    el.className = found.warnings.length ? 'contract-status warn' : 'contract-status ok';
  }

  // Preserve the existing contract indicator while adding bootstrap visibility.
  if (typeof refreshContractStatus === 'function') {
    const _v5RefreshContractStatus = refreshContractStatus;
    refreshContractStatus = function () {
      _v5RefreshContractStatus();
      sceneBootstrapStatus();
    };
  }

  const _v5FormToSettings = formToSettings;
  formToSettings = function () {
    const settings = _v5FormToSettings();
    settings.sceneBootstrapTemplate = $('sceneBootstrapTemplate')?.value || DEFAULT_SCENE_BOOTSTRAP_TEMPLATE;
    return settings;
  };

  const _v5SettingsToForm = settingsToForm;
  settingsToForm = function (settings) {
    _v5SettingsToForm(settings);
    if ($('sceneBootstrapTemplate')) {
      $('sceneBootstrapTemplate').value = settings.sceneBootstrapTemplate || DEFAULT_SCENE_BOOTSTRAP_TEMPLATE;
    }
    setTimeout(sceneBootstrapStatus, 0);
  };

  if ($('sceneBootstrapTemplate')) {
    $('sceneBootstrapTemplate').value = state.settings?.sceneBootstrapTemplate || DEFAULT_SCENE_BOOTSTRAP_TEMPLATE;
  }

  $('workflowJson')?.addEventListener('input', () => setTimeout(sceneBootstrapStatus, 0));

  async function ensureBootstrapCanonicalImage() {
    const selected = $('referenceFile')?.files?.[0];
    if (selected) {
      const filename = await uploadReferenceIfNeeded();
      if (!filename) throw new Error('Canonical image upload did not return a filename.');
      state.settings.referenceImage = filename;
      state.continuityFrame = filename;
      if ($('referenceName')) $('referenceName').textContent = filename;
      // Avoid uploading a second duplicate copy when Save Setup is clicked later.
      $('referenceFile').value = '';
      return filename;
    }
    const current = state.settings.referenceImage || '';
    if (!current) throw new Error('Choose or upload a canonical image before running vision bootstrap.');
    return current;
  }

  async function runSceneBootstrap() {
    if (state.sceneBootstrap.running) return;
    if (!state.workflow || !Object.keys(state.workflow).length) throw new Error('Adopt/save the API workflow before running scene bootstrap.');

    const canonical = await ensureBootstrapCanonicalImage();
    const workflow = deepClone(state.workflow);
    const found = discoverSceneBootstrap(workflow);
    if (found.errors.length) {
      throw new Error(`Vision bootstrap wiring is incomplete: ${found.errors.join('; ')}`);
    }

    const roles = resolvedRoles(workflow);
    const firstLoader = workflow[String(roles.first_frame_loader)];
    if (!firstLoader?.inputs) throw new Error('Could not resolve the canonical first-frame image loader.');
    firstLoader.inputs[state.workflowContract?.dynamic_inputs?.image_filename || 'image'] = canonical;

    const bootstrapPrompt = $('sceneBootstrapTemplate')?.value || state.settings.sceneBootstrapTemplate || DEFAULT_SCENE_BOOTSTRAP_TEMPLATE;
    applyNodeInput(workflow, found.input.id, 'text', bootstrapPrompt, true);
    applyNodeInput(workflow, found.input.id, 'label', 'scene_bootstrap_input', false);

    const outputId = nextSyntheticNodeId(workflow);
    workflow[outputId] = {
      class_type: SHOWRUNNER_OUTPUT_CLASS,
      inputs: { text: [String(found.output.id), 0] },
      _meta: { title: 'Live H3 Scene Bootstrap Output (app injected)' },
    };

    const bootstrapWorkflow = pruneToTarget(workflow, outputId);
    randomizeSeeds(bootstrapWorkflow);

    const button = $('runSceneBootstrapBtn');
    if (button) button.disabled = true;
    state.sceneBootstrap.running = true;
    state.sceneBootstrap.input = bootstrapPrompt;
    if ($('sceneBootstrapInputTrace')) $('sceneBootstrapInputTrace').textContent = bootstrapPrompt;
    if ($('sceneBootstrapOutputTrace')) $('sceneBootstrapOutputTrace').textContent = 'Running…';
    if ($('sceneBootstrapStatus')) {
      $('sceneBootstrapStatus').textContent = 'Analyzing canonical image with the workflow vision node…';
      $('sceneBootstrapStatus').className = 'contract-status warn';
    }

    const started = performance.now();
    const token = { cancelled: false, promptId: null };
    try {
      const promptId = await queuePromptV3(bootstrapWorkflow, { front: true });
      token.promptId = promptId;
      state.sceneBootstrap.promptId = promptId;
      const { record } = await waitForRecordV3(promptId, token, 10 * 60 * 1000);
      const payload = extractShowrunnerPayload(record, outputId);
      if (!payload?.text) throw new Error('Vision bootstrap completed but no text output was captured.');

      const elapsedMs = performance.now() - started;
      const parsed = parseSceneBootstrapOutput(payload.text);
      state.sceneBootstrap.output = payload.text;
      state.sceneBootstrap.parsed = parsed;
      state.sceneBootstrap.elapsedMs = elapsedMs;

      if ($('sceneBootstrapOutputTrace')) $('sceneBootstrapOutputTrace').textContent = payload.text;
      if ($('sceneBootstrapDetails')) $('sceneBootstrapDetails').open = true;

      if (!parsed.basePrompt.trim()) throw new Error('Vision bootstrap returned no base_prompt text.');

      // Apply immediately in-memory + to the form. Save Setup persists it.
      state.settings.basePrompt = parsed.basePrompt;
      if ($('basePrompt')) $('basePrompt').value = parsed.basePrompt;

      if (parsed.idleBeats.length) {
        const beatText = parsed.idleBeats.join('\n');
        state.settings.idleBeats = beatText;
        if ($('idleBeats')) $('idleBeats').value = beatText;
      }

      if (parsed.sceneName && !String(state.settings.sceneName || $('sceneName')?.value || '').trim()) {
        state.settings.sceneName = parsed.sceneName;
        if ($('sceneName')) $('sceneName').value = parsed.sceneName;
      }

      if ($('sceneBootstrapStatus')) {
        $('sceneBootstrapStatus').textContent = `Vision bootstrap applied in ${(elapsedMs / 1000).toFixed(2)}s · prompt_id=${promptId}${parsed.parseError ? ' · raw-text fallback used' : ''}${parsed.notes ? ` · ${parsed.notes}` : ''}`;
        $('sceneBootstrapStatus').className = parsed.parseError ? 'contract-status warn' : 'contract-status ok';
      }
      addMessage('system', `Vision bootstrap updated the base scene prompt${parsed.idleBeats.length ? ` and ${parsed.idleBeats.length} idle beats` : ''}. Save Setup to persist the changes.`, 'system');
    } finally {
      state.sceneBootstrap.running = false;
      if (button) button.disabled = false;
    }
  }

  $('runSceneBootstrapBtn')?.addEventListener('click', () => runSceneBootstrap().catch(handleError));

  sceneBootstrapStatus();
}, 0);
