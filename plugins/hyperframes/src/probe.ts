/** What ffprobe says about the source: size, length, whether it has sound. */
import { execFile } from 'node:child_process';

export interface Probe {
  width: number;
  height: number;
  durationMs: number;
  hasAudio: boolean;
}

export function probe(ffprobe: string, file: string, signal?: AbortSignal): Promise<Probe> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
      { signal, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr.trim().split('\n')[0] || err.message));
        const info = JSON.parse(stdout) as {
          streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[];
          format?: { duration?: string };
        };
        const video = info.streams?.find((s) => s.codec_type === 'video' && s.width && s.height);
        if (!video) return reject(new Error('no video stream'));
        const seconds = Number(info.format?.duration ?? video.duration);
        resolve({
          width: video.width!,
          height: video.height!,
          durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
          hasAudio: !!info.streams?.some((s) => s.codec_type === 'audio'),
        });
      },
    );
  });
}
