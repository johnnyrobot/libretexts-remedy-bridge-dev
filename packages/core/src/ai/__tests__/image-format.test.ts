import { afterEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { imageSourceFromUrl } from '../llm-client.js';
afterEach(() => vi.unstubAllGlobals());
it('normalizes static GIF to PNG for vision inference', async () => {
  const gif = await sharp({ create: { width: 10, height: 20, channels: 3, background: '#f00' } }).gif().toBuffer();
  const image = await imageSourceFromUrl('data:image/gif;base64,' + gif.toString('base64'));
  expect(image.kind).toBe('bytes');
  if (image.kind !== 'bytes') throw Error('Expected bytes');
  expect(image.mimeType).toBe('image/png');
  const metadata = await sharp(image.bytes).metadata();
  expect(metadata.width).toBe(10); expect(metadata.height).toBe(20);
});
it('rejects animated GIF instead of silently describing one frame', async () => {
  const gif = await sharp({ create: { width: 10, height: 20, channels: 3, background: '#f00' } }).gif().toBuffer();
  // Two-frame fixture assembled by repeating the image descriptor + pixels.
  const start = gif.indexOf(0x2c);
  const animated = Buffer.concat([gif.subarray(0, gif.length - 1), gif.subarray(start, gif.length - 1), Buffer.from([0x3b])]);
  await expect(imageSourceFromUrl('data:image/gif;base64,' + animated.toString('base64'))).rejects.toThrow('manual review');
});
it('places transparent black line art on white without losing opaque black pixels', async () => {
  const png = await sharp(Buffer.from([0,0,0,0, 0,0,0,255]),{raw:{width:2,height:1,channels:4}}).png().toBuffer();
  const image=await imageSourceFromUrl('data:image/png;base64,' + png.toString('base64'));
  if(image.kind!=='bytes')throw Error('Expected bytes');
  const {data,info}=await sharp(image.bytes).raw().toBuffer({resolveWithObject:true});
  expect(info.channels).toBe(3);expect([...data]).toEqual([255,255,255,0,0,0]);
});
