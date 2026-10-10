/** The public native IC-Light node contract, composed with standard ComfyUI nodes. */
export interface Lighting {
  prompt: string;
  negativePrompt: string;
  seed: number;
  steps: number;
  cfg: number;
  denoise: number;
}

export interface WorkflowInput extends Lighting {
  image: string;
  checkpoint: string;
  icLightModel: string;
  width: number;
  height: number;
  prefix: string;
}

export type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export const REQUIRED_NODES = [
  'CheckpointLoaderSimple',
  'UNETLoader',
  'LoadImage',
  'ImageScale',
  'VAEEncodeArgMax',
  'ICLightAppply',
  'CLIPTextEncode',
  'KSampler',
  'VAEDecode',
  'SaveImage',
] as const;

/** ICLightAppply is the upstream registration's spelling (three p's), not its display label. */
export function workflow(a: WorkflowInput): Workflow {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: a.checkpoint } },
    '2': { class_type: 'UNETLoader', inputs: { unet_name: a.icLightModel, weight_dtype: 'default' } },
    '3': { class_type: 'LoadImage', inputs: { image: a.image } },
    '4': {
      class_type: 'ImageScale',
      inputs: {
        image: ['3', 0],
        upscale_method: 'lanczos',
        width: a.width,
        height: a.height,
        crop: 'disabled',
      },
    },
    '5': { class_type: 'VAEEncodeArgMax', inputs: { pixels: ['4', 0], vae: ['1', 2] } },
    '6': { class_type: 'ICLightAppply', inputs: { model: ['1', 0], ic_model: ['2', 0], c_concat: ['5', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: a.prompt, clip: ['1', 1] } },
    '8': { class_type: 'CLIPTextEncode', inputs: { text: a.negativePrompt, clip: ['1', 1] } },
    '9': {
      class_type: 'KSampler',
      inputs: {
        model: ['6', 0],
        positive: ['7', 0],
        negative: ['8', 0],
        latent_image: ['5', 0],
        seed: a.seed,
        steps: a.steps,
        cfg: a.cfg,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: a.denoise,
      },
    },
    '10': { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['1', 2] } },
    '11': { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: a.prefix } },
  };
}

/** Preserve aspect, never upscale the input, and align the processing canvas to latent pixels. */
export function processingSize(width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(8, Math.round((width * scale) / 8) * 8),
    height: Math.max(8, Math.round((height * scale) / 8) * 8),
  };
}
