/** The kind of file a video is, from the browser's word for it or else from the end of its name (which is what a phone or a camera is sure of). */
export function videoTypeOf(blob: Blob, name: string): string {
  const t = blob.type.toLowerCase();
  if (t === 'video/mp4' || t === 'video/webm' || t === 'video/quicktime' || t === 'video/x-matroska') return t;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mkv') return 'video/x-matroska';
  return t;
}
