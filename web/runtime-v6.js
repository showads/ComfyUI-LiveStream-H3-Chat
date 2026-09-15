// Live H3 runtime v6: MiniMax-native detailed_description showrunner + LLM-directed duration.
//
// The showrunner no longer returns separate action/dialogue fields. It authors the
// complete detailed_description in target-video playback order, including speaker
// IDs and <d>[Language] ...</d> dialogue markup. The app then inserts that body
// into the stable full-reference scaffold immediately before overall_soundscape.
//
// For chat/proactive beats the showrunner may also recommend a duration. The app
// clamps it to configured bounds, snaps it to the local H3 24fps 17k+5 frame
// lattice, and uses the resulting plan for the video run.

const V6_DEFAULT_SHOWRUNNER_TEMPLATE = `You are the showrunner and MiniMax H3 prompt writer for a persistent live video scene.
Return ONLY valid JSON. Do not use markdown fences.

YOUR OUTPUT HAS TWO JOBS
1. Choose an appropriate duration for this one video segment.
2. Write the complete MiniMax full-reference detailed_description for that duration.

DURATION POLICY
- hard minimum: {duration_min} seconds
- preferred normal range: {duration_preferred_min} to {duration_preferred_max} seconds
- hard maximum: {duration_max} seconds
- Use the shortest duration that comfortably contains the requested speech and visible action.
- Prefer the normal range for ordinary conversational responses.
- A very small request should not be padded with unnecessary action; use the minimum practical duration and allow a natural quiet settle at the end.
- Use longer durations only when the requested physical action, dialogue, or continuous performance genuinely needs them.
- The renderer runs at 24 fps and the app will snap your suggestion slightly to H3's valid frame lattice.

MODE: {showrunner_mode}
VIEWER MESSAGE: {chat_message}
SUGGESTED IDLE BEAT: {idle_beat}
RECENT CHAT:
{chat_history}

CONTINUITY
{reset_instruction}
The supplied first frame is the exact visual starting state. Preserve identity, wardrobe, lighting, set, camera position, object state, and physical continuity. Prefer one continuous [Shot 1] unless a cut is explicitly requested or genuinely necessary.

STABLE SCENE DEFINITION
{base_prompt}

DETAILED_DESCRIPTION RULES
- Write the detailed_description body in English, while preserving the original language of spoken dialogue or visible text.
- Do NOT output the heading detailed_description inside the JSON value; output only its body.
- Establish style/continuity in one or two natural English sentences before [Shot 1] when useful.
- [Shot 1] marks the opening shot and has no timestamp. Only later shots use [Shot N] At MM:SS.mmm, ... and all timestamps must fit inside suggested_seconds.
- Describe visuals, physical action, camera behavior, sound, and dialogue together in target-video playback order. Do not split action and dialogue into separate planning fields.
- Reuse full-reference labels such as <Subject 1> and <Picture 1> only according to the stable scene definition. Do not redefine them.
- When a referenced subject physically speaks, write the visual subject label and stable speaker ID together, for example: <Subject 1> (S1) looks toward the camera and says, <d>[English] Hello there.</d>
- Assign (S1), (S2), etc. by the order of actual vocal events and reuse the same ID for the same speaker throughout the segment.
- ALL actual dialogue, narration, or lyrics must be inside <d>[Language] ...</d>. Never put the literal spoken line in a separate JSON field.
- End complete spoken statements, questions, and exclamations with normal punctuation before </d>.
- If there is no speech, do not invent a speaker ID or dialogue tag.
- For a normal chained clip, begin naturally from the supplied first frame and finish in a physically stable state suitable for direct continuation.
- For a reset clip with a supplied final-frame target, describe a continuous path that lands naturally on that target by the end.
- Generation-task detailed_description is normally rich and specific (MiniMax guidance is commonly 350-500 English words), but do not mechanically pad a simple short live segment. Temporal correctness and complete dialogue/action take priority over word count.

Return exactly this JSON shape:
{
  "suggested_seconds": 8.0,
  "detailed_description": "complete playback-ordered MiniMax detailed_description body, including any <Subject N> (Sx) and <d>[Language] ...</d> markup",
  "beat": "short label for what this moment accomplishes",
  "notes": "optional short reasoning about duration or continuity"
}`;

function v6NumberSetting(name, fallback) {
  const value = Number(state.settings?.[name]);
  return Number.isFinite(value) ? value : fallback;
}

function v6DurationBounds() {
  let hardMin = Math.max(0.1, v6NumberSetting('directorDurationMin', 5.2));
  let preferredMin = Math.max(hardMin, v6NumberSetting('directorPreferredMin', 7.0));
  let preferredMax = Math.max(preferredMin, v6NumberSetting('directorPreferredMax', 12.0));
  let hardMax = Math.max(preferredMax, v6NumberSetting('directorDurationMax', 20.0));
  return { hardMin, preferredMin, preferredMax, hardMax };
}

function v6Clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function v6NextValidFrameAtOrAbove(frames) {
  let value = Math.max(1, Math.round(frames));
  while (value % 17 !== 5) value += 1;
  return value;
}

// Replace the original 362-frame cap with a configurable local ceiling. The
// official MiniMax prompt-writing guide currently documents 4-15s, but this app
// intentionally allows a user-configurable experimental ceiling for local H3
// workflows that support longer generations.
h3FramePlan = function (seconds) {
  const bounds = v6DurationBounds();
  const desiredSeconds = Math.max(0.1, Number(seconds || bounds.preferredMin));
  const requestedFrames = Math.round(desiredSeconds * H3_FPS);
  const minFrames = H3_MIN_TRAINED_FRAMES;
  const configuredMaxFrames = v6NextValidFrameAtOrAbove(bounds.hardMax * H3_FPS);
  let alignedFrames = Math.max(minFrames, requestedFrames);
  alignedFrames = v6NextValidFrameAtOrAbove(alignedFrames);
  alignedFrames = Math.min(alignedFrames, configuredMaxFrames);
  return {
    fps: H3_FPS,
    desiredSeconds,
    requestedFrames,
    alignedFrames,
    modelSeconds: alignedFrames / H3_FPS,
    clamped: alignedFrames !== v6NextValidFrameAtOrAbove(Math.max(minFrames, requestedFrames)),
  };
};

function v6LooksLikeLegacyShowrunner(text) {
  const value = String(text || '');
  return /"dialogue"\s*:/.test(value) && /"action"\s*:/.test(value) && !/"detailed_description"\s*:/.test(value);
}

function v6ParseShowrunnerJson(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(text);
    const detailed = String(parsed.detailed_description || '').trim();
    if (!detailed) throw new Error('missing detailed_description');
    return {
      suggested_seconds: Number(parsed.suggested_seconds),
      detailed_description: detailed,
      beat: String(parsed.beat || ''),
      notes: String(parsed.notes || ''),
      raw: parsed,
      parse_error: false,
    };
  } catch (_) {
    // A raw prose response is still more useful than losing the run entirely.
    // Duration falls back to the existing chat plan.
    return {
      suggested_seconds: NaN,
      detailed_description: text,
      beat: 'fallback',
      notes: 'Showrunner output was not valid v6 JSON; raw text was used as detailed_description.',
      raw: { parse_error: true, raw: text },
      parse_error: true,
    };
  }
}

parseShowrunnerJson = v6ParseShowrunnerJson;

function v6RenderShowrunnerTemplate(template, intent) {
  const bounds = v6DurationBounds();
  const baseRendered = renderTemplate(template || V6_DEFAULT_SHOWRUNNER_TEMPLATE, intent.source?.text || '');
  return templateReplace(baseRendered, {
    duration_min: bounds.hardMin.toFixed(2),
    duration_preferred_min: bounds.preferredMin.toFixed(2),
    duration_preferred_max: bounds.preferredMax.toFixed(2),
    duration_max: bounds.hardMax.toFixed(2),
    showrunner_mode: intent.type === 'chat' ? 'viewer_chat_response' : 'proactive_idle_beat',
    idle_beat: intent.beat || '',
    reset_instruction: intent.isReset
      ? 'A final-frame target is supplied. The detailed_description must describe a physically continuous path from the supplied first frame that lands naturally on that exact final visual state by the end.'
      : 'No final-frame target is supplied. Continue naturally from the exact supplied first frame and end in a stable state suitable for the next clip.',
  });
}

runShowrunner = async function (intent, token) {
  const workflow = deepClone(state.workflow);
  const roles = resolvedRoles(workflow);
  if (!roles.director_input_trace || !roles.llm_output_trace) throw new Error('The adopted workflow is missing director_input or llm_output trace roles.');

  const configuredTemplate = state.settings.showrunnerTemplate || V6_DEFAULT_SHOWRUNNER_TEMPLATE;
  const template = v6LooksLikeLegacyShowrunner(configuredTemplate) ? V6_DEFAULT_SHOWRUNNER_TEMPLATE : configuredTemplate;
  const directorPrompt = v6RenderShowrunnerTemplate(template, intent);

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
  if (outputTrace?.timestamp_ms && inputTrace?.timestamp_ms) {
    llmMs = Math.max(0, outputTrace.timestamp_ms - inputTrace.timestamp_ms);
  }
  if (llmMs == null) llmMs = finishedAt - queuedAt;

  const parsed = v6ParseShowrunnerJson(payload.text);
  const durationEnabled = state.settings.showrunnerControlsDuration !== false;
  if (durationEnabled && Number.isFinite(parsed.suggested_seconds)) {
    const bounds = v6DurationBounds();
    const requested = v6Clamp(parsed.suggested_seconds, bounds.hardMin, bounds.hardMax);
    intent.plan = h3FramePlan(requested);
  }

  return {
    directorPrompt,
    raw: payload.text,
    parsed,
    llmMs,
    promptId,
  };
};

function v6StripDetailedHeading(text) {
  return String(text || '').trim()
    .replace(/^\s*detailed_description\s*:?\s*/i, '')
    .trim();
}

function v6SplitStableScaffold(basePrompt) {
  let base = String(basePrompt || '').trim();

  // If an older hand-written base accidentally contains detailed_description,
  // discard that transient body but keep the stable sound/music suffix.
  const detailMatch = /(?:^|\n)\s*detailed_description\s*:?\s*(?:\n|$)/i.exec(base);
  const soundMatch = /(?:^|\n)\s*overall_soundscape\s*:?\s*(?:\n|$)/i.exec(base);

  if (detailMatch) {
    const prefix = base.slice(0, detailMatch.index).trim();
    const suffixMatch = /(?:^|\n)\s*overall_soundscape\s*:?\s*(?:\n|$)/i.exec(base.slice(detailMatch.index + detailMatch[0].length));
    const suffix = suffixMatch
      ? base.slice(detailMatch.index + detailMatch[0].length + suffixMatch.index).trim()
      : '';
    return { prefix, suffix };
  }

  if (soundMatch) {
    return {
      prefix: base.slice(0, soundMatch.index).trim(),
      suffix: base.slice(soundMatch.index).trim(),
    };
  }

  return { prefix: base, suffix: '' };
}

function v6AssembleFullReferencePrompt(basePrompt, detailedDescription) {
  const { prefix, suffix } = v6SplitStableScaffold(basePrompt);
  const body = v6StripDetailedHeading(detailedDescription);
  return [
    prefix,
    `detailed_description\n${body}`,
    suffix,
  ].filter((x) => String(x || '').trim()).join('\n\n').trim();
}

formatDirectedPrompt = function (_intent, showrunner) {
  return v6AssembleFullReferencePrompt(
    state.settings.basePrompt || '',
    showrunner.detailed_description || '',
  );
};

// Normal idle remains LLM-free, but it now uses the same correct field ordering
// and writes an actual detailed_description instead of tacking prose on after the
// complete base prompt.
directIdlePrompt = function (intent) {
  const beat = String(intent.beat || 'maintain a calm attentive posture with subtle natural breathing and blinking').trim();
  const continuity = intent.isReset
    ? 'A final-frame target is supplied; the motion resolves naturally toward that target by the end of the shot.'
    : 'The shot ends in a stable, natural state suitable for direct continuation.';
  const body = `The target video continues the same realistic live scene with the existing camera, lighting, wardrobe, and environment unchanged.\n[Shot 1] The shot begins from the supplied first frame. <Subject 1> remains physically consistent with the established reference and ${beat.replace(/\.$/, '')}. No spoken dialogue occurs in this segment. ${continuity}`;
  return v6AssembleFullReferencePrompt(state.settings.basePrompt || '', body);
};

setTimeout(() => {
  // -------------------------------------------------------------------------
  // Setup UI / migration
  // -------------------------------------------------------------------------
  const showrunnerLabel = $('showrunnerTemplate')?.closest('label')?.querySelector('span');
  if (showrunnerLabel) showrunnerLabel.textContent = 'Showrunner prompt → duration + complete detailed_description JSON';

  const directedField = $('directedH3Template')?.closest('label');
  if (directedField) directedField.style.display = 'none';

  const chatDurationLabel = $('chatSeconds')?.closest('label')?.querySelector('span');
  if (chatDurationLabel) chatDurationLabel.textContent = 'Chat fallback duration (seconds; used if LLM duration is off/invalid)';

  const showrunnerField = $('showrunnerTemplate')?.closest('label');
  if (showrunnerField && !$('v6DurationPolicy')) {
    showrunnerField.insertAdjacentHTML('beforebegin', `
      <div id="v6DurationPolicy" class="v3-card">
        <div class="section-head"><div><div class="eyebrow">LLM temporal direction</div><h3>Let the showrunner choose segment duration</h3></div></div>
        <div class="setup-grid">
          <label class="check-field"><span>Showrunner controls chat/proactive duration</span><input id="showrunnerControlsDuration" type="checkbox" checked /></label>
          <label><span>Hard minimum seconds</span><input id="directorDurationMin" type="number" min="1" max="20" step="0.1" value="5.2" /></label>
          <label><span>Preferred minimum seconds</span><input id="directorPreferredMin" type="number" min="1" max="20" step="0.1" value="7" /></label>
          <label><span>Preferred maximum seconds</span><input id="directorPreferredMax" type="number" min="1" max="20" step="0.1" value="12" /></label>
          <label><span>Hard maximum seconds</span><input id="directorDurationMax" type="number" min="1" max="30" step="0.1" value="20" /></label>
        </div>
        <p class="small mono">The LLM picks the smallest duration that fits the requested action/dialogue, normally aiming for the preferred band. The app then snaps it to H3's 24fps 17k+5 frame grid. MiniMax's public prompt guide currently documents 4–15s; values above 15s are treated here as an experimental local-workflow capability.</p>
      </div>
    `);
  }

  const _v6FormToSettings = formToSettings;
  formToSettings = function () {
    const settings = _v6FormToSettings();
    settings.showrunnerControlsDuration = $('showrunnerControlsDuration')?.checked !== false;
    settings.directorDurationMin = Number($('directorDurationMin')?.value || 5.2);
    settings.directorPreferredMin = Number($('directorPreferredMin')?.value || 7.0);
    settings.directorPreferredMax = Number($('directorPreferredMax')?.value || 12.0);
    settings.directorDurationMax = Number($('directorDurationMax')?.value || 20.0);
    const currentTemplate = $('showrunnerTemplate')?.value || '';
    settings.showrunnerTemplate = v6LooksLikeLegacyShowrunner(currentTemplate)
      ? V6_DEFAULT_SHOWRUNNER_TEMPLATE
      : (currentTemplate || V6_DEFAULT_SHOWRUNNER_TEMPLATE);
    return settings;
  };

  const _v6SettingsToForm = settingsToForm;
  settingsToForm = function (settings) {
    const migrated = { ...settings };
    if (!migrated.showrunnerTemplate || v6LooksLikeLegacyShowrunner(migrated.showrunnerTemplate)) {
      migrated.showrunnerTemplate = V6_DEFAULT_SHOWRUNNER_TEMPLATE;
      state.settings.showrunnerTemplate = V6_DEFAULT_SHOWRUNNER_TEMPLATE;
    }
    _v6SettingsToForm(migrated);
    if ($('showrunnerControlsDuration')) $('showrunnerControlsDuration').checked = migrated.showrunnerControlsDuration !== false;
    if ($('directorDurationMin')) $('directorDurationMin').value = String(migrated.directorDurationMin ?? 5.2);
    if ($('directorPreferredMin')) $('directorPreferredMin').value = String(migrated.directorPreferredMin ?? 7.0);
    if ($('directorPreferredMax')) $('directorPreferredMax').value = String(migrated.directorPreferredMax ?? 12.0);
    if ($('directorDurationMax')) $('directorDurationMax').value = String(migrated.directorDurationMax ?? 20.0);
    if ($('showrunnerTemplate')) $('showrunnerTemplate').value = migrated.showrunnerTemplate;
  };

  // Current page may already have been populated by prior runtime layers.
  if (!$('showrunnerTemplate')?.value || v6LooksLikeLegacyShowrunner($('showrunnerTemplate')?.value)) {
    if ($('showrunnerTemplate')) $('showrunnerTemplate').value = V6_DEFAULT_SHOWRUNNER_TEMPLATE;
    state.settings.showrunnerTemplate = V6_DEFAULT_SHOWRUNNER_TEMPLATE;
  }
  if ($('showrunnerControlsDuration')) $('showrunnerControlsDuration').checked = state.settings.showrunnerControlsDuration !== false;
  if ($('directorDurationMin')) $('directorDurationMin').value = String(state.settings.directorDurationMin ?? 5.2);
  if ($('directorPreferredMin')) $('directorPreferredMin').value = String(state.settings.directorPreferredMin ?? 7.0);
  if ($('directorPreferredMax')) $('directorPreferredMax').value = String(state.settings.directorPreferredMax ?? 12.0);
  if ($('directorDurationMax')) $('directorDurationMax').value = String(state.settings.directorDurationMax ?? 20.0);

  const existingHelp = $('showrunnerRuntimeHelp');
  if (existingHelp) {
    existingHelp.textContent = 'Chat/proactive preflight: the existing text LLM returns suggested_seconds plus one complete playback-ordered detailed_description. Dialogue stays inline using MiniMax speaker IDs and <d>[Language] ...</d>. The app inserts that field between retention_analysis and overall_soundscape, then renders H3.';
  }
}, 0);
