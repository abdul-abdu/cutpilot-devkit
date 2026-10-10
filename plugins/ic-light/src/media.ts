import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { PluginFailure } from '@nodcut/plugin-sdk';

export function executable(setting: unknown, name: string): string | null {
  const configured = typeof setting === 'string' ? setting.trim() : '';
  const paths = configured
    ? [configured]
    : (process.env.PATH ?? '')
        .split(process.platform === 'win32' ? ';' : ':')
        .concat(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'] : [])
        .filter(Boolean)
        .map((p) => join(p, process.platform === 'win32' ? `${name}.exe` : name));
  for (const file of paths) {
    try {
      accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return file;
    } catch {
      /* try the next executable */
    }
  }
  return null;
}

export function run(exe: string, args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { signal, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let errors = '';
    child.stdout.on('data', (b: Buffer) => {
      output = (output + b.toString()).slice(-64_000);
    });
    child.stderr.on('data', (b: Buffer) => {
      errors = (errors + b.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (code !== 0)
        reject(
          new PluginFailure(
            'E_PLUGIN_FAILED',
            `${exe.split(/[\\/]/).pop()} failed: ${errors.replace(/[\r\n]+/g, ' ').slice(-700)}`,
            'check the source file and the FFmpeg/FFprobe paths in plugin settings',
          ),
        );
      else resolve(output);
    });
  });
}

export interface Media {
  width: number;
  height: number;
  fps: number;
  durationMs: number | null;
  hasAudio: boolean;
}

export async function probe(file: string, ffprobe: string, signal: AbortSignal): Promise<Media> {
  if (!isAbsolute(file) || !existsSync(file))
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      'the source must be an existing absolute file path',
      'get the source path from list_media and pass that path to the relighting tool',
    );
  const result = JSON.parse(
    await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], signal),
  ) as {
    streams: {
      codec_type: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      duration?: string;
    }[];
    format?: { duration?: string };
  };
  const video = result.streams.find((s) => s.codec_type === 'video');
  if (!video?.width || !video.height)
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      'the source has no picture or video stream',
      'choose a picture or video from list_media',
    );
  const [n, d] = (video.avg_frame_rate ?? '0/1').split('/').map(Number);
  const duration = Number(result.format?.duration ?? video.duration);
  return {
    width: video.width,
    height: video.height,
    fps: n > 0 && d > 0 ? n / d : 25,
    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null,
    hasAudio: result.streams.some((s) => s.codec_type === 'audio'),
  };
}

export function range(media: Media, startMs: number, endMs: number | undefined, maxSeconds: number) {
  const end = endMs ?? media.durationMs;
  if (
    media.durationMs === null ||
    end === null ||
    end <= startMs ||
    startMs >= media.durationMs ||
    end > media.durationMs
  )
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      'the requested video range is outside the source',
      'pass startMs and endMs in source milliseconds within the video duration',
    );
  if (end - startMs > maxSeconds * 1000)
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      `the requested range exceeds the ${maxSeconds}s experimental limit`,
      'start with a short clip, or deliberately raise Maximum video seconds in plugin settings; every frame is processed and can flicker',
    );
  if (media.fps < 1 || media.fps > 120)
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      'the source frame rate must be between 1 and 120 fps',
      'use a source with a standard frame rate',
    );
  return { startMs, endMs: end, durationMs: end - startMs };
}
