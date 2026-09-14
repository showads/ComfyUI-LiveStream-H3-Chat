import json
import time


class LiveH3TraceText:
    """Pass-through STRING node that records exact text + timestamp in history/UI output."""

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
    CATEGORY = "Live H3 Chat"

    def trace(self, text, label):
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


class LiveH3ShowrunnerOutput:
    """Temporary/output boundary used by the app for director-only preflight runs.

    The app injects this output node into a cloned API workflow, prunes that clone
    to the LLM dependency chain, and queues it separately from the video workflow.
    Users normally do not need to place this node manually on the canvas.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"forceInput": True, "multiline": True}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "capture"
    OUTPUT_NODE = True
    CATEGORY = "Live H3 Chat"

    def capture(self, text):
        if isinstance(text, list):
            value = "\n".join(str(x) for x in text)
        else:
            value = str(text)
        payload = {
            "text": value,
            "timestamp_ms": int(time.time() * 1000),
        }
        return {
            "ui": {"showrunner": [json.dumps(payload, ensure_ascii=False)]},
            "result": (),
        }


NODE_CLASS_MAPPINGS = {
    "LiveH3TraceText": LiveH3TraceText,
    "LiveH3ShowrunnerOutput": LiveH3ShowrunnerOutput,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LiveH3TraceText": "Live H3 Trace Text",
    "LiveH3ShowrunnerOutput": "Live H3 Showrunner Output",
}
