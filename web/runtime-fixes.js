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
