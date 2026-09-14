// Small post-v2 corrections kept separate so existing runtime code remains easy
// to diff while the prototype is moving quickly.

// 5.0s -> raw 120 frames -> H3 snaps upward to 124 (~5.17s).
// 5.2s -> raw 125 frames -> next valid 17k+5 value is 141 (~5.88s), so use
// 5.0s as the short-segment default when no saved v2 value exists yet.
const _v2SettingsToForm = settingsToForm;
settingsToForm = function (settings) {
  _v2SettingsToForm(settings);
  if (settings.idleSeconds == null) setField('idleSeconds', 5.0);
  if (settings.resetSeconds == null) setField('resetSeconds', 5.0);
};

// If chat arrives during startup prefill before any clip is actually playing,
// preemption rewinds the continuity cursor to the canonical image. Reset chain
// depth too so reset cadence stays consistent with that rewind.
const _v2PreemptIdleFutureForChat = preemptIdleFutureForChat;
preemptIdleFutureForChat = function () {
  const hadPlayingSegment = !!state.currentSegment;
  _v2PreemptIdleFutureForChat();
  if (!hadPlayingSegment) {
    state.chainDepth = 0;
    updateMetrics();
  }
};

// v3 is concatenated after this file. Defer these safety/contract refinements to
// the next task so they wrap the final v3 definitions rather than the v2 ones.
setTimeout(() => {
  if (typeof resolveWorkflowContract === 'function') {
    resolveWorkflowContract = function (workflow, contract = state.workflowContract || state.settings?.workflowContract) {
      if (!contract?.roles) return { resolved: null, errors: ['No adopted workflow contract is saved.'] };
      const roles = {};
      const errors = [];

      // H3 is the semantic anchor. Derive the two image-loader roles from the
      // live H3 connections instead of trying to distinguish identical LoadImage
      // nodes by title or numeric id.
      const h3Id = resolveSelector(workflow, contract.roles.h3);
      if (!h3Id) errors.push('Could not resolve workflow role: h3');
      else {
        roles.h3 = h3Id;
        const h3Node = workflow[String(h3Id)];
        const firstId = upstreamNodeId(h3Node, contract.dynamic_inputs?.h3_first_frame || 'first_frame');
        const lastId = upstreamNodeId(h3Node, contract.dynamic_inputs?.h3_last_frame || 'last_frame');
        if (firstId && workflow[firstId]) roles.first_frame_loader = firstId;
        else errors.push('Could not resolve workflow role: first_frame_loader');
        if (lastId && workflow[lastId]) roles.last_frame_loader = lastId;
        else errors.push('Could not resolve workflow role: last_frame_loader');
      }

      for (const name of ['director_input_trace', 'llm_output_trace', 'final_prompt_trace', 'video_output']) {
        const selector = contract.roles[name];
        if (!selector) continue;
        const id = resolveSelector(workflow, selector);
        if (id) roles[name] = id;
        else if (name !== 'final_prompt_trace') errors.push(`Could not resolve workflow role: ${name}`);
      }
      return { resolved: { ...roles, inputs: contract.dynamic_inputs || {} }, errors };
    };
  }

  if (typeof interruptPrompt === 'function') {
    interruptPrompt = async function (promptId) {
      // Never issue a global Comfy interrupt from this app. If we do not yet know
      // the prompt id, mark the work stale and let the targeted interrupt happen
      // once queuePrompt returns its id.
      if (!promptId) return false;
      try {
        const res = await fetch('/interrupt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt_id: promptId }),
        });
        return res.ok;
      } catch (_) {
        return false;
      }
    };
  }

  if (typeof waitForRecordV3 === 'function') {
    const _safeBaseWaitForRecordV3 = waitForRecordV3;
    waitForRecordV3 = async function (promptId, token, timeoutMs) {
      if (token?.cancelled) {
        await interruptPrompt(promptId);
        throw new LiveH3CancelledError();
      }
      return _safeBaseWaitForRecordV3(promptId, token, timeoutMs);
    };
  }
}, 0);

// v4 UX/runtime fixes. This callback runs after runtime-v3.js has finished
// evaluating, so these wrappers intentionally target the final v3 behavior.
setTimeout(() => {
  // ---------------------------------------------------------------------------
  // Make the showrunner/idle controls describe what the runtime actually does.
  // ---------------------------------------------------------------------------
  const showrunnerLabel = $('showrunnerTemplate')?.closest('label')?.querySelector('span');
  if (showrunnerLabel) showrunnerLabel.textContent = 'Showrunner LLM preflight prompt (must return JSON)';

  const proactiveLabel = $('proactiveChance')?.closest('label')?.querySelector('span');
  if (proactiveLabel) proactiveLabel.textContent = 'Chance an idle beat uses the LLM showrunner (0–1)';

  const idleBeatsLabel = $('idleBeats')?.closest('label')?.querySelector('span');
  if (idleBeatsLabel) idleBeatsLabel.textContent = 'Idle beat library (one direct H3 action per line)';

  const idleBeatsField = $('idleBeats')?.closest('label');
  if (idleBeatsField && !$('idleBeatRuntimeHelp')) {
    idleBeatsField.insertAdjacentHTML('afterend', `
      <p id="idleBeatRuntimeHelp" class="small mono">
        Normal idle: one beat is appended directly to the H3 idle prompt and the LLM is not called.
        Proactive idle: the selected beat is supplied to the showrunner as SUGGESTED SCENE BEAT with an empty viewer message.
        It is not masquerading as chat.
      </p>
    `);
  }

  const showrunnerField = $('showrunnerTemplate')?.closest('label');
  if (showrunnerField && !$('showrunnerRuntimeHelp')) {
    showrunnerField.insertAdjacentHTML('afterend', `
      <p id="showrunnerRuntimeHelp" class="small mono">
        This is a separate preflight ComfyUI run. The app injects this text into the director_input trace,
        executes the existing LLM path only through llm_output, parses the returned JSON, then starts a second
        H3 video run with the deterministic formatted prompt.
      </p>
    `);
  }

  // ---------------------------------------------------------------------------
  // Idle clip reuse. We intentionally reuse only the *currently playing* plain
  // idle clip. Arbitrarily recycling an older FL clip can break continuity because
  // its first frame may no longer match the live chain. Replaying the current clip
  // still ends on the same frame from which the next generated segment continues.
  // ---------------------------------------------------------------------------
  const targetBufferField = $('targetBufferSeconds')?.closest('label');
  if (targetBufferField && !$('idleReuseCount')) {
    targetBufferField.insertAdjacentHTML('afterend', `
      <label>
        <span>Idle replays before generating a refresh</span>
        <input id="idleReuseCount" type="number" min="0" max="20" step="1" value="2" />
      </label>
    `);
  }

  const _v4FormToSettings = formToSettings;
  formToSettings = function () {
    const settings = _v4FormToSettings();
    settings.idleReuseCount = Math.max(0, Math.round(Number($('idleReuseCount')?.value ?? 2) || 0));
    return settings;
  };

  const _v4SettingsToForm = settingsToForm;
  settingsToForm = function (settings) {
    _v4SettingsToForm(settings);
    if ($('idleReuseCount')) $('idleReuseCount').value = String(settings.idleReuseCount ?? 2);
  };

  // The original config load may already have happened before this wrapper was
  // installed. Populate the new field from the in-memory settings immediately.
  if ($('idleReuseCount')) $('idleReuseCount').value = String(state.settings?.idleReuseCount ?? 2);

  function idleReplayLimit() {
    return Math.max(0, Math.round(Number(state.settings?.idleReuseCount ?? 2) || 0));
  }

  function currentPlaybackRemainingSeconds() {
    const segment = state.currentSegment;
    if (!segment) return 0;
    const player = players[state.activePlayer];
    const duration = Number(segment.actualDuration || segment.modelSeconds || player?.duration || 0);
    if (!(duration > 0)) return 0;
    if (!player || !Number.isFinite(Number(player.currentTime))) return duration;
    return Math.max(0, duration - Number(player.currentTime || 0));
  }

  function reusableIdleReserveSeconds() {
    const segment = state.currentSegment;
    if (!segment || segment.promptType !== 'idle') return 0;
    const duration = Number(segment.actualDuration || segment.modelSeconds || 0);
    if (!(duration > 0)) return 0;
    const used = Math.max(0, Number(segment.idleReplayCount || 0));
    const left = Math.max(0, idleReplayLimit() - used);
    return left * duration;
  }

  function effectivePlayableSecondsV4() {
    return bufferedSeconds() + currentPlaybackRemainingSeconds() + reusableIdleReserveSeconds();
  }

  // ---------------------------------------------------------------------------
  // Persist the user's audio choice. The old MVP always forced muted=true when
  // playback restarted after an underrun.
  // ---------------------------------------------------------------------------
  if (state.audioMuted == null) state.audioMuted = players[state.activePlayer]?.muted !== false;

  function syncAudioPreference() {
    const active = players[state.activePlayer];
    if (!active) return;
    state.audioMuted = !!active.muted;
    if ($('muteBtn')) $('muteBtn').textContent = state.audioMuted ? 'Unmute' : 'Mute';
  }

  if (!state._v4AudioListenersInstalled) {
    state._v4AudioListenersInstalled = true;
    $('muteBtn')?.addEventListener('click', () => setTimeout(syncAudioPreference, 0));
    players.forEach((player) => player.addEventListener('volumechange', () => {
      if (player === players[state.activePlayer]) syncAudioPreference();
    }));
  }

  startPlaybackIfNeeded = async function () {
    if (state.currentSegment || !state.buffer.length) return;
    const first = state.buffer.shift();
    state.currentSegment = first;
    first.idleReplayCount = first.idleReplayCount || 0;
    const player = players[state.activePlayer];
    resetPlayer(player);
    player.src = first.url;
    player.dataset.segmentId = String(first.id);
    player.classList.add('active');
    player.muted = !!state.audioMuted;
    if ($('muteBtn')) $('muteBtn').textContent = state.audioMuted ? 'Unmute' : 'Mute';
    try { await player.play(); } catch (_) {}
    prepareNextDeck();
    updateMetrics();
  };

  advancePlayback = async function () {
    if (!state.running) return;

    if (!state.buffer.length) {
      const current = state.currentSegment;
      const active = players[state.activePlayer];
      const canReplayIdle = current?.promptType === 'idle' && Number(current.idleReplayCount || 0) < idleReplayLimit();

      if (canReplayIdle) {
        current.idleReplayCount = Number(current.idleReplayCount || 0) + 1;
        active.muted = !!state.audioMuted;
        try { active.currentTime = 0; } catch (_) {}
        try { await active.play(); } catch (_) {}
        setStatus(`Reusing idle filler (${current.idleReplayCount}/${idleReplayLimit()}) while the stream catches up…`, 'busy');
        updateMetrics();
        return;
      }

      // Keep the ended video visible on its last frame. Do not clear
      // currentSegment: clearing it caused the misleading "No live scene yet"
      // overlay and routed playback through the old forced-mute startup path.
      setStatus('Buffer underrun — holding the last frame while generating…', 'busy');
      updateMetrics();
      while (state.running && !state.buffer.length) {
        if (!state.generating) await generateSegment(false);
        else await sleep(200);
      }
      if (!state.running) return;
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

    next.idleReplayCount = next.idleReplayCount || 0;
    newPlayer.muted = !!state.audioMuted;
    newPlayer.classList.add('active');
    oldPlayer.classList.remove('active');
    state.activePlayer = newIndex;
    state.currentSegment = next;

    try { await newPlayer.play(); } catch (_) {}
    resetPlayer(oldPlayer);
    prepareNextDeck();
    if ($('muteBtn')) $('muteBtn').textContent = state.audioMuted ? 'Unmute' : 'Mute';
    updateMetrics();
  };

  // Count the remaining current playback and allowed idle replays as usable
  // coverage. This stops the governor from generating unique idle clips just to
  // maintain an arbitrary seconds target when a safe current filler can be reused.
  maintainBufferLoop = async function () {
    while (state.running) {
      try {
        const targetSeconds = effectiveTargetBufferSeconds();
        if (state.pendingChat.length && !state.generating) await generateSegment(false);
        else if (effectivePlayableSecondsV4() < targetSeconds && !state.generating) await generateSegment(false);
        else await sleep(200);
      } catch (err) {
        handleError(err);
        await sleep(1000);
      }
    }
  };

  // Make the startup/underrun overlay truthful. After a scene has started, an
  // empty stage means buffering rather than missing setup.
  const _v4UpdateMetrics = updateMetrics;
  updateMetrics = function () {
    _v4UpdateMetrics();
    const empty = $('stageEmpty');
    if (empty && state.running && !state.currentSegment) {
      const title = empty.querySelector('.stage-empty-title');
      if (title) title.textContent = 'Prefilling live scene…';
      const body = empty.querySelector('.stage-empty-title + div');
      if (body) body.textContent = 'Generating enough video to begin playback.';
    } else if (empty && !state.running) {
      const title = empty.querySelector('.stage-empty-title');
      if (title) title.textContent = 'No live scene yet';
      const body = empty.querySelector('.stage-empty-title + div');
      if (body) body.textContent = 'Open Setup, choose the canonical frame and API workflow, then prefill the buffer.';
    }
  };

  // ---------------------------------------------------------------------------
  // Trace contract validation. Node IDs are intentionally *not* the identity of
  // a trace. The semantic labels are. Validate topology too so a green check
  // cannot merely mean "three trace nodes with the right labels exist somewhere".
  // ---------------------------------------------------------------------------
  function dependsOnNode(workflow, targetId, ancestorId, seen = new Set()) {
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
      if (upstream === ancestorId || dependsOnNode(workflow, upstream, ancestorId, seen)) return true;
    }
    return false;
  }

  if (typeof discoverWorkflowContract === 'function') {
    const _v4DiscoverWorkflowContract = discoverWorkflowContract;
    discoverWorkflowContract = function (workflow) {
      const result = _v4DiscoverWorkflowContract(workflow);
      if (result.errors.length) return result;

      const director = findTraceNode(workflow, 'director_input');
      const llmOutput = findTraceNode(workflow, 'llm_output');
      const finalPrompt = findTraceNode(workflow, 'final_h3_prompt');

      if (director && llmOutput && !dependsOnNode(workflow, llmOutput.id, director.id)) {
        result.errors.push(
          `Trace topology is invalid: llm_output (#${llmOutput.id}) is not downstream of director_input (#${director.id}).`
        );
      }
      if (finalPrompt && llmOutput && !dependsOnNode(workflow, finalPrompt.id, llmOutput.id)) {
        result.warnings.push(
          `final_h3_prompt (#${finalPrompt.id}) is not downstream of llm_output (#${llmOutput.id}); v3 can still run because it builds the final H3 prompt in-app.`
        );
      }
      return result;
    };
  }

  refreshContractStatus = function () {
    const status = $('workflowContractStatus');
    const mappingGrid = document.querySelector('.mapping-grid');
    const workflowHelp = document.querySelector('.workflow-help');
    let workflow = state.workflow;
    try {
      const text = $('workflowJson')?.value;
      if (text?.trim()) workflow = JSON.parse(text);
    } catch (err) {
      if (status) {
        status.textContent = `Workflow JSON is invalid: ${err?.message || err}`;
        status.className = 'contract-status error';
      }
      if (mappingGrid) mappingGrid.style.display = '';
      return;
    }

    if (!workflow || !Object.keys(workflow).length) {
      if (status) {
        status.textContent = 'No workflow adopted yet. Paste an API workflow once, then click Adopt workflow.';
        status.className = 'contract-status warn';
      }
      if (mappingGrid) mappingGrid.style.display = '';
      return;
    }

    const discovery = discoverWorkflowContract(workflow);
    const resolved = !discovery.errors.length
      ? resolveWorkflowContract(workflow, discovery.contract)
      : { resolved: null, errors: [] };
    const errors = [...discovery.errors, ...(resolved.errors || [])];
    const roles = resolved.resolved || {};
    const warnings = discovery.warnings || [];

    if (status) {
      if (errors.length) {
        status.textContent = `Contract invalid: ${errors.join(' ')}`;
        status.className = 'contract-status error';
      } else {
        const ids = [
          `H3 #${roles.h3}`,
          `first #${roles.first_frame_loader}`,
          `last #${roles.last_frame_loader}`,
          `director #${roles.director_input_trace}`,
          `LLM out #${roles.llm_output_trace}`,
          roles.final_prompt_trace ? `final prompt #${roles.final_prompt_trace}` : 'final prompt: app-owned',
          `video #${roles.video_output}`,
        ];
        status.textContent = `Contract ready · ${ids.join(' · ')}${warnings.length ? ` · ${warnings.join(' ')}` : ''}`;
        status.className = 'contract-status ok';
      }
    }

    const ready = !errors.length && !!resolved.resolved;
    if (mappingGrid) mappingGrid.style.display = ready ? 'none' : '';
    if (workflowHelp) workflowHelp.style.display = ready ? 'none' : '';
    const rawLabel = $('workflowJson')?.closest('label');
    if (rawLabel) rawLabel.classList.toggle('workflow-raw-hidden', ready && !$('workflowRawVisible')?.checked);
  };

  // The details panel is below the table; previously it could open outside the
  // viewport and look like the button did nothing. Delegate again at document
  // level and bring the revealed panel into view.
  if (!state._v4DiagnosticsClickInstalled) {
    state._v4DiagnosticsClickInstalled = true;
    document.addEventListener('click', (event) => {
      const btn = event.target.closest?.('.diag-detail-btn');
      if (!btn) return;
      event.preventDefault();
      showDiagnosticDetail(btn.dataset.id);
      const detail = $('diagnosticsDetail');
      if (detail) {
        detail.classList.remove('hidden');
        requestAnimationFrame(() => detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      }
    });
  }

  refreshContractStatus();
  updateMetrics();
}, 0);
