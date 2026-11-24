/** Browser-compatible: serialized with the probe; no Node or application authority. */
export async function validateViewerPayload({ file, expected }) {
  if (file.path !== expected.path) throw Error('Viewer HTTP path changed');
  if (file.truncated !== false) throw Error('Unexpected viewer truncation');
  const encoded = new globalThis.TextEncoder().encode(file.content);
  if (file.bytes !== expected.bytes || encoded.byteLength !== expected.bytes)
    throw Error('Viewer HTTP UTF-8 bytes changed');
  if (file.content.length !== expected.codeUnits) throw Error('Viewer HTTP code units changed');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== expected.contentHash) throw Error('Viewer HTTP content hash changed');
}

/** Header text is insufficient: both changed first-line cells must be present. */
export function diffRowsReady(rows, expected) {
  const changed = rows.filter((row) => row.state === 'diff');
  return (
    changed.some(
      (row) =>
        row.old === '1' && (row.text ?? row.plainText ?? row.syntaxText) === expected.oldFirstLine,
    ) &&
    changed.some(
      (row) =>
        row.next === '1' && (row.text ?? row.plainText ?? row.syntaxText) === expected.newFirstLine,
    )
  );
}
