import json
import time


class LiveH3TraceText:
    """Pass-through STRING node that records exact text + timestamp in history/UI output.

    Put one before the LLM, one directly after it, and optionally one immediately
    before the H3 prompt input. The standalone app can read these records from
    ComfyUI history to show exact prompts and estimate per-stage latency.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"forceInput": True, "multiline": True}),
                "label": ("STRING", {"default": "trace"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "trace"
    OUTPUT_NODE = True
    CATEGORY = "Live H3 Chat"

    def trace(self, text, label):
        # Some text nodes can emit a one-item list; keep the pass-through useful
        # while normalizing the diagnostic payload to a plain string.
        if isinstance(text, list):
            value = "\n".join(str(x) for x in text)
        else:
            value = str(text)

        payload = {
            "label": str(label),
            "text": value,
            "timestamp_ms": int(time.time() * 1000),
        }
        return {
            "ui": {"trace": [json.dumps(payload, ensure_ascii=False)]},
            "result": (value,),
        }


NODE_CLASS_MAPPINGS = {
    "LiveH3TraceText": LiveH3TraceText,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LiveH3TraceText": "Live H3 Trace Text",
}
