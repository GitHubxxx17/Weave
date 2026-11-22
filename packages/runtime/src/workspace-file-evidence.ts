import { open } from 'node:fs/promises';
const maxBytes = 1_000_000;
/** Bounded even if an external process grows the file after metadata checks. */
export async function readFileEvidence(target: string): Promise<Buffer> {
  const handle = await open(target, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes)
      throw new Error('File evidence exceeds the regular-file capture limit');
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < bytes.byteLength) {
      const result = await handle.read(bytes, count, bytes.byteLength - count, count);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
    }
    if (count > maxBytes) throw new Error('File evidence exceeds the capture limit');
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
}
