# ComfyUI Live H3 Chat

A standalone ComfyUI web app for building a continuously generated video scene that can react to live text input.

The first target is an AI presenter / news-anchor setup, but the app is deliberately workflow-agnostic: any ComfyUI API workflow that accepts a text prompt and produces a playable media file can be mapped into the controller.

## What it does

- Adds a standalone UI at `/live-h3-chat/` on the same host/port as ComfyUI.
- Stores a reusable **scene setup**: reference image, base prompt, idle prompt template, chat-response template, API workflow, and workflow-node mappings.
- Prefills an initial segment buffer before playback starts.
- Plays generated segments continuously in the browser.
- Keeps generating in the background to maintain a target buffer.
- Accepts live text input and injects queued messages into upcoming segment prompts.
- Uses two alternating `<video>` elements so the next segment can preload while the current one plays.
- Works through ComfyUI's normal `/prompt`, `/history`, and `/view` APIs. The extension itself does not load or own the H3 model.

## Installation

```bash
cd /workspace/ComfyUI/custom_nodes
git clone https://github.com/showads/ComfyUI-LiveStream-H3-Chat.git
```

Restart ComfyUI, then open:

```text
http://YOUR-COMFY-HOST:8188/live-h3-chat/
```

If you expose ComfyUI through RunPod's proxy, use the same proxied ComfyUI URL and append `/live-h3-chat/`.

There are no additional Python dependencies beyond ComfyUI/aiohttp.

## Recommended first experiment

Start with a constrained scene:

- one person
- seated or mostly stationary
- locked camera
- fixed lighting and wardrobe
- one consistent set
- subtle idle movement
- short spoken responses

A news anchor at a desk is ideal.

### Base prompt example

```text
A single presenter is seated behind a modern news desk in the same studio. Locked medium camera shot. The camera never moves. The presenter, wardrobe, desk, studio background and lighting remain visually identical between segments. Natural breathing, blinking and restrained hand gestures. Professional but conversational delivery.
```

The setup screen then wraps that base prompt in separate templates for idle segments and chat-response segments.

## Setup flow

### 1. Build and test the video workflow in normal ComfyUI

Use whichever H3/LTX/etc workflow you want. Confirm that it successfully saves a video with `SaveVideo` (or another output node that returns a file record in ComfyUI history).

### 2. Export the workflow in API format

In ComfyUI use the API workflow export, then paste the resulting JSON into **API workflow JSON** in the app.

Do **not** paste the normal UI workflow JSON; `/prompt` needs the API-prompt shape with numeric node IDs as keys.

### 3. Map dynamic inputs

The app needs to know which workflow fields it may replace before every segment:

- **Prompt node ID / input** — required. Example: node `12`, input `text`.
- **Reference image node ID / input** — optional. Usually a `LoadImage` node with input `image`.
- **Seed node ID / input** — optional. A new random seed is injected per segment.
- **Output node ID / preferred output key** — required. Usually a video-saving node and `videos`.

You can also provide arbitrary **Static input overrides** as JSON. These are useful for frame count, resolution, filename prefix, sampler settings, etc.

Example:

```json
{
  "14": {
    "frames": 192
  },
  "31": {
    "filename_prefix": "live_h3/segment"
  }
}
```

### 4. Choose the reference image

The app uploads the selected image into:

```text
ComfyUI/input/live_h3_chat/
```

and inserts that filename into the mapped workflow input on every generated segment.

Whether this actually conditions the generated video depends entirely on the workflow/model you provide.

### 5. Configure the buffer

**Initial buffer segments** are generated before playback starts. This is intentionally the startup delay that buys the app enough runway to keep playback continuous.

**Target buffer segments** is how many completed clips the app tries to keep waiting ahead of the currently playing clip.

For early testing, `3 / 3` is a reasonable starting point.

## Runtime behavior

When you press **Start / Prefill**:

1. The app generates the configured number of initial idle clips.
2. Playback begins once the initial buffer is complete.
3. The controller keeps generating clips one at a time until the target buffer is satisfied.
4. A chat message is placed in a queue.
5. The next generation slot consumes the oldest pending chat message and uses the chat-response template.
6. Playback reaches that newly generated segment naturally.

So the interaction is intentionally **buffered rather than instant**. The UI stays smooth even when generation is slower than real-time, as long as average generation throughput remains ahead of playback consumption.

## H3 / RAVEN note

The current `ComfyUI-MiniMax-H3-RAVEN-Streaming` project provides streaming T2VA generation and a ready-made API workflow. Its documented streaming path currently uses the official H3 conditioning node in T2VA form, with no first/last frame connected. That makes it useful for testing the rolling architecture, but not necessarily the best first graph for strict reference-image identity/continuity. The Live H3 Chat app therefore does not depend on RAVEN and does not hard-code its node IDs.

For a reference-image presenter, use an H3 image/reference-conditioned workflow that you have verified locally, then map its prompt/image/output inputs here. Later we can add a dedicated RAVEN adapter once we decide exactly how we want to handle cross-segment visual state.

Reference implementation: https://github.com/YanzuoLu/ComfyUI-MiniMax-H3-RAVEN-Streaming

## Current MVP limitations

- Chat text is currently injected directly into the video prompt. There is no separate LLM/dialogue-writer yet.
- Continuity currently comes from your reference image + prompt + model/workflow. The app does not yet extract the previous clip's final frame and feed it into the next clip.
- Generation is single-flight: one ComfyUI segment is queued at a time by this app.
- If generation falls behind playback, the player waits for the next completed segment and reports a buffer underrun.
- Browser autoplay starts muted. Click **Unmute** once playback begins.
- The app expects the selected output node to expose a normal ComfyUI file record (`filename`, `subfolder`, `type`) in prompt history.

## Next steps

The architecture intentionally leaves room for:

1. previous-frame / previous-clip conditioning
2. a dedicated MiniMax H3 RAVEN adapter
3. OpenAI-compatible or local-LLM dialogue generation
4. explicit spoken-script generation + TTS/audio-conditioned video
5. transition/crossfade logic
6. generation-speed telemetry and adaptive buffer sizing
7. multiple characters / scene states
8. reusable scene presets

## Repository structure

```text
ComfyUI-LiveStream-H3-Chat/
├── __init__.py
├── server.py
├── web/
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── data/                 # created at runtime
    ├── settings.json
    └── workflow.json
```
