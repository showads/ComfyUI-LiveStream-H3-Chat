# ComfyUI Live H3 Chat

A standalone ComfyUI web app for continuously generated MiniMax H3 video/audio scenes that react to live text input.

The first target is an AI presenter / news-anchor setup, but the controller is scene-agnostic. The current runtime is optimized around **MiniMax H3 FL2VA**: one canonical setup image starts the scene, every generated clip hands its final frame to the next clip, and periodic reset clips converge back to the canonical image without changing H3 model families.

## What it does

- Adds a standalone UI at `/live-h3-chat/` on the same host/port as ComfyUI.
- Stores scene prompts, a canonical/reset image, API workflow JSON, temporal settings, and node mappings.
- Prefills and maintains the playback buffer in **seconds**, not segment count.
- Uses the previous generated clip's final frame as the next FL2VA first frame.
- Periodically performs a **continuity reset** using:
  - first frame = previous clip's actual final frame
  - last frame = the original canonical/setup image
- Accepts live chat and prioritizes it without reordering an already-generated FL chain. Unplayed idle future clips are flushed when chat needs to preempt them.
- Supports an in-workflow LLM director for literal dialogue generation.
- Includes a `Live H3 Trace Text` ComfyUI node for exact prompt capture and timing diagnostics.
- Probes generated media with `ffprobe` when available and extracts the final video frame with `ffmpeg` for the next generation.
- Uses two alternating browser video elements so the next segment can preload.

## Installation

```bash
cd /workspace/ComfyUI/custom_nodes
git clone https://github.com/showads/ComfyUI-LiveStream-H3-Chat.git
```

For an existing clone:

```bash
cd /workspace/ComfyUI/custom_nodes/ComfyUI-LiveStream-H3-Chat
git pull
```

Restart ComfyUI after installing/updating, then open:

```text
http://YOUR-COMFY-HOST:8188/live-h3-chat/
```

If you use RunPod's ComfyUI proxy, append `/live-h3-chat/` to the same proxied URL.

The app itself has no pip dependencies beyond ComfyUI/aiohttp. `ffmpeg` + `ffprobe` are strongly recommended for continuity extraction and media diagnostics; most ComfyUI video environments already include them.

---

## Recommended H3 graph

Use a local **H3 FL2VA / Image-to-Video** workflow with both first and last frame inputs available in the exported API graph.

Conceptually:

```text
Load Image [dynamic first] ───────────────► H3 first_frame

Load Image [canonical reset image] ──────► H3 last_frame
                                             ▲
                                             │
                                    app removes this input
                                    on normal chain clips;
                                    restores it on reset clips
```

For ordinary clips the app deletes the optional `last_frame` input from the API prompt, so H3 runs from only the first frame.

For a reset clip the app restores the exported `last_frame` connection:

```text
previous actual final frame
          │
          ▼
     first_frame
          │
        H3 FL
          │
      last_frame
          ▲
          │
original canonical image
```

The reset therefore remains one continuous H3 FL generation instead of switching to Ref2VA or another model partition.

---

## LLM director + observability wiring

This extension adds a pass-through ComfyUI node named:

```text
Live H3 Trace Text
```

Recommended graph:

```text
app director prompt
       │
       ▼
Live H3 Trace Text        label: director_input
       │
       ▼
      LLM
       │
       ▼
Live H3 Trace Text        label: llm_output
       │
       ▼
optional formatter / concat
       │
       ▼
Live H3 Trace Text        label: final_h3_prompt
       │
       ▼
 H3 prompt input
```

Each trace node returns the input string unchanged, while also writing a timestamped diagnostic record into ComfyUI history.

With all three configured, the app can display:

- exact director input sent toward the LLM
- exact LLM output
- exact final text entering H3
- measured LLM time (input trace → output trace)
- H3/downstream time (final prompt trace → workflow completion)
- total Comfy workflow time
- requested frame count / duration
- probed output frame count / fps / duration / file size
- first frame used for the segment
- extracted final frame used for continuity
- whether the segment was a canonical reset
- whether a generated idle clip was discarded because live chat preempted its future chain

The diagnostics table keeps the latest 100 rows in the browser session. Click **Details** on a row to inspect all text and continuity metadata.

---

## Temporal behavior: H3's 17k+5 frame grid

The current native local H3 conditioning in ComfyUI runs at **24 fps** and aligns requested length upward until:

```text
frame_count % 17 == 5
```

The app therefore accepts desired durations in seconds but converts them to an H3-valid frame count before submitting the workflow.

Examples:

| Desired | Raw @ 24fps | H3-aligned | Model duration |
| ---: | ---: | ---: | ---: |
| 5.0s | 120 | 124 | 5.167s |
| 7.0s | 168 | 175 | 7.292s |
| 8.0s | 192 | 192 | 8.000s |
| 10.0s | 240 | 243 | 10.125s |
| 15.0s | 360 | 362 | 15.083s |

The app currently clamps dynamic requests to the commonly documented/trained local range of roughly **124–362 frames**.

This is why thinking in exact round-number seconds can be misleading. The Diagnostics table shows both the aligned requested timing and the actual encoded media timing from `ffprobe`.

---

## Setup fields

### Temporal control

- **Initial buffer (seconds)** — how much completed video is generated before playback starts.
- **Target buffer (seconds)** — how much unplayed video the controller tries to maintain.
- **Idle desired duration** — target duration for silent/background segments.
- **Chat desired duration** — target duration for LLM-directed response segments.
- **Reset desired duration** — target duration for the convergence-to-canonical segment.
- **Reset after chained clips** — after this many free-running chained clips, the next clip is generated as `current final frame → canonical image`. Set `0` to disable.

### Prompt mappings

- **H3 prompt / FL node ID** — H3 conditioning node containing the prompt input.
- **H3 prompt input** — usually `prompt` on the native H3 node.
- **LLM director node ID / input** — used when the app writes directly into the LLM.
- **LLM input trace node ID** — optional but recommended for exact LLM latency.
- **LLM output trace node ID** — recommended for raw LLM response capture.
- **Final H3 prompt trace node ID** — recommended for exact final H3 input capture.

If an LLM input trace node is configured, the app writes the director prompt into that trace node instead of directly into the LLM; wire the trace output to the LLM input.

### FL mappings

- **First-frame Load Image node ID / filename input** — app changes this filename every generation.
- **Last-frame Load Image node ID / filename input** — app keeps this pointed at the canonical image.
- **FL target node ID** — node containing optional `last_frame`; defaults to the H3 prompt node.
- **Optional last-frame input** — usually `last_frame`.
- **Frame-count node ID / input** — where the app writes aligned frame length; usually the H3 node's `length` input.

### Output mappings

- **Output video node ID** — `Save Video`, VHS combine, or equivalent output node.
- **Preferred output key** — usually `videos`; the app also falls back to scanning other file-record arrays.

Keep the output/saver node. The controller needs its normal ComfyUI history file record to play, probe, and extract the continuity frame.

---

## Runtime behavior

When **Start / Prefill** is pressed:

1. The canonical image becomes the first continuity frame.
2. Idle clips generate sequentially until the configured initial-buffer seconds are satisfied.
3. Each completed clip is probed and its final frame is extracted into:

```text
ComfyUI/input/live_h3_chat/continuity/
```

4. That extracted image becomes the next clip's first frame.
5. Playback starts.
6. Background generation continues until the target-buffer seconds are satisfied.
7. After the configured chain depth, a reset segment uses the current final frame as first frame and canonical image as last frame.
8. After that reset completes, chaining continues from the **actual generated final frame** of the reset clip.

### Chat preemption

FL continuity means generated future clips cannot safely be reordered. If the generated chain is:

```text
A → B → C
```

we cannot insert newly generated D between A and B if D was conditioned from C.

Therefore when chat arrives, the controller:

1. keeps the currently playing segment
2. discards unplayed future idle segments
3. returns the continuity cursor to the current segment's known final frame
4. allows an already-running stale idle job to finish but discards its result
5. generates the chat response from the correct continuity frame
6. resumes forward chaining

During early development this can cause a buffer underrun if chat generation is slower than the remaining playing time. That is intentional: preserving correct visual causality is more important than silently showing a discontinuous clip.

---

## Prompting guidance

For idle clips, avoid asking H3 to invent dialogue. Keep them visual and silent:

```text
The presenter quietly reviews the papers, glances toward the monitor, blinks, breathes naturally, and remains seated. No spoken dialogue occurs.
```

For chat clips, let the LLM write literal spoken dialogue, then send that complete prompt to H3.

The director template supports these runtime variables in addition to the existing scene/chat variables:

```text
{segment_seconds}
{segment_frames}
{is_reset}
{reset_instruction}
```

On reset clips the app also appends an explicit instruction telling the director/H3 to make one continuous shot converge to the supplied final frame.

---

## Current implementation notes

- Generation is single-flight: one ComfyUI generation at a time from this controller.
- Playback uses ordinary ComfyUI `/prompt`, `/history`, and `/view` endpoints.
- Media URLs are cache-busted so saver nodes that reuse a filename do not make the browser appear to replay the first clip forever.
- Final-frame extraction currently happens from the encoded saved video via `ffmpeg`. A future optimization could capture the last decoded frame directly inside the Comfy graph and avoid the encode/decode round trip.
- Extracted continuity PNGs currently accumulate in `input/live_h3_chat/continuity/`; cleanup/retention policy is a future quality-of-life improvement.
- Browser autoplay begins muted; click **Unmute** once playback starts.

## Repository structure

```text
ComfyUI-LiveStream-H3-Chat/
├── __init__.py
├── nodes.py                 # Live H3 Trace Text
├── server.py                # app routes + ffprobe/ffmpeg helpers
├── web/
│   ├── index.html
│   ├── app.js               # original MVP shell
│   ├── director-patch.js    # FL runtime / diagnostics v2
│   └── styles.css
└── data/                    # created at runtime
    ├── settings.json
    └── workflow.json
```
