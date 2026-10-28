/**
 * The picture as it goes to the server: drawn again on a canvas and encoded as a JPEG, which is also what takes away everything else a camera file carries (where it was taken,
 * the camera, a thumbnail). It is the picture the puzzle is played from (at most 1600 pixels on its longest side), so every player cuts the same one.
 */
export async function pictureForUpload(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(source, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be prepared'))), 'image/jpeg', 0.9));
}
