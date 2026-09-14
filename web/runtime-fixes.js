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
