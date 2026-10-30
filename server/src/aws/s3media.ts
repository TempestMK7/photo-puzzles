import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { MediaGate } from '../router';
import type { Signer } from '../signing';
import type { Media } from '../types';

/** Where a room's picture lives in the bucket. */
export const mediaKey = (roomId: string): string => `rooms/${roomId}`;

/**
 * Pictures in a private S3 bucket. The creator's picture goes **through the service** (to `<api>/media/<room>`, an address that the service signed): the service looks at the
 * bytes and only then puts them in the bucket, so nothing that is not a picture of the right size is ever stored. Members read it straight from S3 through a signed address.
 */
export class S3Media implements Media, MediaGate {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly signer: Signer,
    /** The public address of the API, where uploads are sent. */
    private readonly apiBase: string,
    /** How long a member's address for the picture works, in seconds. */
    private readonly readSeconds = 3600,
  ) {}

  uploadUrl(roomId: string): Promise<string> {
    return this.signer.address(this.apiBase, roomId, 'put');
  }

  signedUrl(roomId: string): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: mediaKey(roomId) }), { expiresIn: this.readSeconds });
  }

  allows(roomId: string, what: 'put' | 'get', exp: string | null, sig: string | null): Promise<boolean> {
    return this.signer.allows(roomId, what, exp, sig);
  }

  async put(roomId: string, bytes: Uint8Array, type: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: mediaKey(roomId), Body: bytes, ContentType: type, CacheControl: 'private, max-age=3600' }));
  }

  async delete(roomId: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: mediaKey(roomId) }));
  }

  /**
   * A video is too large to go through the API (a Lambda takes about 6 MB in a request), so the creator PUTs it straight to the bucket. The address is signed for exactly this kind and
   * size: the bucket turns away a file with another `Content-Type` or `Content-Length`, which is what keeps the size limit (a signed address cannot say "at most").
   */
  async videoUpload(roomId: string, type: string, bytes: number): Promise<{ url: string; headers: Record<string, string> }> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: mediaKey(roomId), ContentType: type, ContentLength: bytes, CacheControl: 'private, max-age=3600' });
    const url = await getSignedUrl(this.s3, command, { expiresIn: 900, signableHeaders: new Set(['content-type', 'content-length', 'cache-control']) });
    return { url, headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' } };
  }

  async inspect(roomId: string, peek: number): Promise<{ bytes: number; head: Uint8Array } | undefined> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: mediaKey(roomId) }));
      const part = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: mediaKey(roomId), Range: `bytes=0-${peek - 1}` }));
      return { bytes: head.ContentLength ?? 0, head: (await part.Body?.transformToByteArray()) ?? new Uint8Array() };
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFound' || (e as { name?: string }).name === 'NoSuchKey') return undefined;
      throw e;
    }
  }
}
