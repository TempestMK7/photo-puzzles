import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { fileKey, mediaKey } from './s3media';

/**
 * Called with what the table's stream says. When a room item is removed (the table's own expiry, or the service deleting it) its picture is deleted too, and when a kept file's
 * item is removed so is the file. The bucket's lifecycle rule is the backstop for anything that slips by. Deleting a picture that is already gone is not an error, so a batch can safely be tried again.
 */
export async function clearPictures(event: DynamoDBStreamEvent, remove: (key: string) => Promise<void>): Promise<number> {
  let n = 0;
  for (const record of event.Records) {
    if (record.eventName !== 'REMOVE') continue;
    const image = record.dynamodb?.OldImage;
    const pk = image?.pk?.S;
    const sk = image?.sk?.S;
    if (pk?.startsWith('ROOM#') && sk === 'META') await remove(mediaKey(pk.slice('ROOM#'.length)));
    else if (pk?.startsWith('FILE#') && sk === 'FILE') await remove(fileKey(pk.slice('FILE#'.length)));
    else continue;
    n++;
  }
  return n;
}

let s3: S3Client | undefined;

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  s3 ??= new S3Client({});
  const client = s3;
  const bucket = process.env.MEDIA_BUCKET;
  if (!bucket) throw new Error('MEDIA_BUCKET is not set');
  await clearPictures(event, async (key) => void (await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))));
};
