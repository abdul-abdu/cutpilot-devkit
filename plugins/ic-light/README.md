# IC-Light

Relight a source frame or a short video clip with your own local ComfyUI and IC-Light SD1.5 models. The plugin runs as a NodCut MCP server; your AI uses `ic-light__doctor`, `ic-light__setup`, `ic-light__preview` and `ic-light__render`. It returns new files and never changes the recording or the timeline itself.

Video rendering is experimental. IC-Light is an image model: each frame is processed independently with the same prompt and seed, which does **not** ensure temporal consistency. Flicker, face changes, text changes and altered background details are possible. Preview a representative frame and review a short clip before processing more footage. This is generative relighting, not a physically accurate multi-light studio simulation.

## Your ComfyUI and models

Nothing is installed or downloaded by this plugin. Bring these components:

| Component | Where to get it | Terms |
| --- | --- | --- |
| ComfyUI, running locally | [ComfyUI Desktop on Mac](https://docs.comfy.org/installation/desktop/macos) or [manual installation](https://github.com/Comfy-Org/ComfyUI) | [GPL-3.0](https://github.com/Comfy-Org/ComfyUI/blob/master/LICENSE) |
| Native IC-Light nodes | [ComfyUI-IC-Light-Native](https://github.com/huchenlei/ComfyUI-IC-Light-Native), installed into your ComfyUI `custom_nodes` folder; restart ComfyUI afterwards | [Apache-2.0](https://github.com/huchenlei/ComfyUI-IC-Light-Native/blob/main/LICENSE) |
| Foreground IC-Light SD1.5 model, converted for native ComfyUI | [Converted weights](https://huggingface.co/huchenlei/IC-Light-ldm/tree/main): `iclight_sd15_fc_unet_ldm.safetensors`, in ComfyUI `models/unet` | Original [IC-Light weights and terms](https://huggingface.co/lllyasviel/ic-light), Apache-2.0; check the converter’s model card too |
| Your SD1.5 base checkpoint, including compatible CLIP and VAE | Your model publisher; install it in ComfyUI `models/checkpoints` | Your selected model’s separate terms. Supply its actual licence URL to `setup`. The plugin cannot infer a model’s licence from a filename. |
| FFmpeg and FFprobe | Your existing installation, or [FFmpeg](https://ffmpeg.org/download.html) | Your build’s licence; not bundled |

Use the foreground **fc** weights, not **fbc**. SDXL, Flux and the abandoned Diffusers IC-Light wrapper are not used. This workflow conditions on the whole source frame; it does not include a background-removal model or portrait segmentation. It can therefore change the background as well as the subject.

Set the plugin’s **ComfyUI URL** to the server address, normally `http://localhost:8188`; ComfyUI Desktop may use another port. Only loopback HTTP (`localhost`, `127.0.0.1`, `::1`) is accepted. Source frames go to that local server. The plugin contacts no external service and downloads no models; your separately installed ComfyUI and its other nodes have their own behaviour and permissions.

Run `ic-light__doctor`. It lists installed checkpoint and UNet filenames, missing nodes, media tools, server device information and terms. Set **SD1.5 checkpoint** to your installed base model’s exact name and **Converted IC-Light foreground model** to its exact name (including a subfolder, if any). The doctor checks the names; the model’s actual SD1.5 compatibility is checked by ComfyUI during inference.

After the user has seen and accepted these terms and the base checkpoint’s licence, call:

```json
{"tool":"ic-light__setup","arguments":{"agree":true,"checkpointLicenseUrl":"https://your-model-publisher.example/path/to/LICENSE"}}
```

That records acceptance for this local server and model selection under the plugin’s data folder. It does not download, install or run a model. Changing the server or selected model requires acceptance again. NodCut and the plugin do not provide or license your models.

## Try it

From the devkit:

```sh
pnpm build
pnpm vitest run plugins/ic-light
pnpm bundle plugins/ic-light
```

Install with NodCut’s CLI (`nodcut plugin install <devkit>/plugins/ic-light --link` for development, or install the bundled `build/ic-light` folder). Ask your AI to run `ic-light__doctor`, configure the model names in NodCut’s Plugins settings, show you the licences, and record acceptance with `ic-light__setup`.

Get a video’s absolute source path from `list_media`. Preview one frame:

```json
{"tool":"ic-light__preview","arguments":{"source":"/absolute/path/recording.mp4","atMs":1000,"prompt":"soft studio lighting, soft key light from the left, natural skin tones","maxSide":512,"steps":20,"seed":42}}
```

The answer includes a PNG image, its persistent path and the original extracted frame. If the appearance is acceptable, try a one-second clip:

```json
{"tool":"ic-light__render","arguments":{"source":"/absolute/path/recording.mp4","startMs":1000,"endMs":2000,"prompt":"soft studio lighting, soft key light from the left, natural skin tones","maxSide":512,"steps":20,"seed":42}}
```

The tool processes every frame. It returns an MP4 and provenance metadata, and preserves the source’s first audio stream by encoding it to AAC. It creates a constant-frame-rate video from the source’s average frame rate; the selected source-time range and its duration are recorded. Processing uses an aspect-preserving canvas snapped to multiples of eight, then video is resized back to the source dimensions; odd dimensions are padded by one pixel for H.264. Upscaling a relit 512-pixel frame does not recover original detail.

Import the result as separate footage with `add_media`, or `import_media` followed by `add_segment`; `add_layer` can place the relit visual over original narration. A rendered file is not an undoable lighting toggle on the existing source. Existing words, cuts and captions are not rebound to it. Review in NodCut for flicker and appearance changes before using the result.

## Settings and files

| Setting | Default | Meaning |
| --- | --- | --- |
| ComfyUI URL | `http://localhost:8188` | Your local backend and port |
| SD1.5 checkpoint | empty | Base model filename reported by doctor |
| Converted IC-Light foreground model | `iclight_sd15_fc_unet_ldm.safetensors` | Native foreground UNet filename |
| Data folder | `~/.nodcut/ic-light` | Acceptance record and persistent outputs |
| FFmpeg / FFprobe path | find on PATH | Explicit paths override lookup; Homebrew locations are also checked on macOS |
| Frame timeout seconds | 1200 | Per-frame inference limit, 5–7200 seconds |
| Maximum video seconds | 10 | Explicit bound for expensive experimental runs, 1–600 seconds |

Outputs are in `outputs/<unique-id>/`, with `provenance.json`. Successful video renders remove their extracted/processed scratch frames. Failed or cancelled runs remove their output folder. Keep completed MP4s while a NodCut project links them; `import_media` links files rather than copying them. ComfyUI itself retains uploaded frames under `input/nodcut-ic-light` and generated PNGs under its `output/nodcut-ic-light`; manage those in your ComfyUI installation.

Cancellation uses ComfyUI’s current per-job cancellation endpoint, targeting only the plugin’s prompt. On older ComfyUI versions it safely deletes that prompt from the queue; an already running frame may finish. It never sends a global interrupt that could stop another user’s job. Media subprocesses stop when the tool is cancelled.

## Mac and verification

The plugin does not select CUDA or install PyTorch. Its native workflow delegates device selection to your ComfyUI, which supports Apple Silicon MPS. The complete neural workflow still needs an M1 Pro test; no real-time speed or RAM requirement is claimed. Start with a single frame at 512 pixels.

Tests use a local simulated ComfyUI server and real FFmpeg media: model/node checks, acceptance before media upload, prompt submission, image download, source preservation, selected-range timing, audio content, backend failures and cancellation of only the owned job. They do not demonstrate neural lighting quality. The SDK harness also starts the real plugin process with NodCut’s minimal environment, with no models or network needed.

The plugin’s own code is MIT. ComfyUI, custom nodes and model weights remain your own installations under their separate terms; none is bundled or redistributed.
