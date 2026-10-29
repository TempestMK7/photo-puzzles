import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
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
}
