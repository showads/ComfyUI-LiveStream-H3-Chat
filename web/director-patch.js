// Optional LLM-director layer + playback/debug fixes.
// Loaded after app.js so it can extend the original MVP without changing the core file.

const _baseFormToSettings = formToSettings;
formToSettings = function () {
  const settings = _baseFormToSettings();
  settings.directorTemplate = $('directorTemplate')?.value || '';
  settings.mapping.directorNodeId = $('directorNodeId')?.value.trim() || '';
  settings.mapping.directorInput = $('directorInput')?.value.trim() || 'text';
  return settings;
};

const _baseSettingsToForm = settingsToForm;
settingsToForm = function (settings) {
  _baseSettingsToForm(settings);
  const mapping = settings.mapping || {};
  if ($('directorTemplate')) $('directorTemplate').value = settings.directorTemplate || $('directorTemplate').value;
  if ($('directorNodeId')) $('directorNodeId').value = mapping.directorNodeId || '';
  if ($('directorInput')) $('directorInput').value = mapping.directorInput || 'text';
};

// Cache-bust /view URLs. Some video-save nodes reuse a filename, which otherwise
// makes the browser appear to loop the first generated clip forever.
mediaUrl = function (item) {
  const params = new URLSearchParams({
    filename: item.filename,
    subfolder: item.subfolder || '',
    type: item.type || 'output',
    _live_h3: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
  return `/view?${params.toString()}`;
};

buildWorkflow = function (forceIdle = false) {
  const workflow = deepClone(state.workflow);
  const mapping = state.settings.mapping || {};
  const promptInfo = buildPrompt(forceIdle);

  const staticOverrides = state.settings.staticOverrides || {};
  for (const [nodeId, inputs] of Object.entries(staticOverrides)) {
    for (const [inputName, value] of Object.entries(inputs || {})) {
      applyNodeInput(workflow, nodeId, inputName, value, false);
    }
  }

  const useDirector = promptInfo.type === 'chat' && !!mapping.directorNodeId;

  if (useDirector) {
    // The exported API workflow should already have the director's output (or a
    // downstream formatter fed by it) connected to the final H3 prompt input.
    // We only replace the director's text input here, preserving that graph link.
    const promptNode = workflow[String(mapping.promptNodeId)];
    const finalPromptInput = promptNode?.inputs?.[mapping.promptInput || 'text'];
    if (!Array.isArray(finalPromptInput)) {
      throw new Error(
        'LLM Director is configured, but the H3 prompt input is not connected to another node in the exported workflow. ' +
        'Wire the LLM/director output (optionally through a text formatter/concatenate node) into the H3 prompt input, then export the API workflow again.'
      );
    }

    const directorText = renderTemplate(
      state.settings.directorTemplate ||
        'Write the exact next video prompt for this scene. The viewer said: "{chat_message}". ' +
        'Include literal, concise spoken dialogue that fits one segment. Return prompt text only.\n\nScene:\n{base_prompt}\n\nRecent chat:\n{chat_history}',
      promptInfo.source?.text || ''
    );
    applyNodeInput(workflow, mapping.directorNodeId, mapping.directorInput || 'text', directorText, true);
  } else {
    // Idle clips (and chat clips when no director is configured) continue to use
    // the direct prompt-template path.
    applyNodeInput(workflow, mapping.promptNodeId, mapping.promptInput || 'text', promptInfo.text, true);
  }

  if (state.settings.referenceImage && mapping.imageNodeId) {
    applyNodeInput(workflow, mapping.imageNodeId, mapping.imageInput || 'image', state.settings.referenceImage, false);
  }

  if (mapping.seedNodeId) {
    const seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    applyNodeInput(workflow, mapping.seedNodeId, mapping.seedInput || 'seed', seed, false);
  }

  return { workflow, promptInfo };
};

generateSegment = async function (forceIdle = false) {
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

    // Chat responses should be the NEXT clip shown, not sit behind the entire
    // idle buffer. Idle material remains available after the response.
    if (segment.promptType === 'chat') state.buffer.unshift(segment);
    else state.buffer.push(segment);

    const fileLabel = media?.filename ? ` (${media.filename})` : '';
    addMessage(
      'system',
      `Generated segment #${segment.id}${segment.promptType === 'chat' ? ' for chat response' : ''}${fileLabel}.`,
      'system'
    );
    prepareNextDeck();
    return segment;
  } finally {
    state.generating = false;
    updateMetrics();
    if (state.running) setStatus('Live', 'live');
  }
};

maintainBufferLoop = async function () {
  while (state.running) {
    try {
      const target = Math.max(1, Number(state.settings.targetBuffer || 3));

      // Chat is higher priority than topping off the idle buffer. This also
      // allows a response to generate when the buffer is already full.
      if (state.pendingChat.length && !state.generating) {
        await generateSegment(false);
      } else if (state.buffer.length < target && !state.generating) {
        await generateSegment(false);
      } else {
        await sleep(250);
      }
    } catch (err) {
      handleError(err);
      await sleep(1500);
    }
  }
};

// app.js may have loaded saved settings before this extension was evaluated.
// Reload once so the director fields are populated as well.
loadConfig().catch(handleError);
