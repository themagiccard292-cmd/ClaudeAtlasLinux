import { nativeImage } from 'electron';

export const MODEL_MAX_W = 1280;
export const MODEL_MAX_H = 720;

export interface PreparedImage {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * Last line of defence before upload: guarantee ≤1280×720 and a sane JPEG size.
 * The Python backend already produces such frames, so normally this is a no-op
 * (no needless re-encode / quality loss).
 */
export function prepareImage(jpeg: Buffer, maxBytes = 900_000): PreparedImage {
  let img = nativeImage.createFromBuffer(jpeg);
  const { width, height } = img.getSize();
  if (width === 0 || height === 0) throw new Error('Screenshot could not be decoded');
  const tooBig = width > MODEL_MAX_W || height > MODEL_MAX_H;
  if (!tooBig && jpeg.length <= maxBytes) return { buffer: jpeg, width, height };

  if (tooBig) {
    const scale = Math.min(MODEL_MAX_W / width, MODEL_MAX_H / height);
    img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
  }
  let quality = 72;
  let out = img.toJPEG(quality);
  while (out.length > maxBytes && quality > 35) {
    quality -= 10;
    out = img.toJPEG(quality);
  }
  const size = img.getSize();
  return { buffer: out, width: size.width, height: size.height };
}

/** Small preview stored with the chat (keeps chat files light). */
export function thumbnailDataUrl(jpeg: Buffer, width = 640): string {
  const img = nativeImage.createFromBuffer(jpeg);
  const size = img.getSize();
  const small = size.width > width ? img.resize({ width, quality: 'good' }) : img;
  return `data:image/jpeg;base64,${small.toJPEG(60).toString('base64')}`;
}
