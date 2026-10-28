/** What a picture the server was sent is, found without decoding it: only JPEG and PNG are accepted, and the size has to be what the puzzle was made for. */
export function sniffImage(bytes: Uint8Array): { type: 'image/jpeg' | 'image/png'; width: number; height: number } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    // PNG: the IHDR chunk comes first, with the width and height as 32-bit numbers
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
    return { type: 'image/png', width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // JPEG: walk the segments to the first "start of frame", which holds the size
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { type: 'image/jpeg', height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + v.getUint16(i + 2);
    }
  }
  return null;
}
