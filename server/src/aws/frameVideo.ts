import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import type { VideoModeration } from '../types';
import { checkKey } from './s3media';
import type { VideoCheckEvent } from './videoCheck';

/**
 * The look at a video, made of its frames (see `checkVideoFrames`): the function `functionName` is started without waiting for it (it takes a while), writes its verdict to the bucket, and
 * `result` reads it from there (nothing there yet: still working). The job is the room itself.
 */
export class FrameVideoModeration implements VideoModeration {
  constructor(
    private readonly lambda: Pick<LambdaClient, 'send'>,
    private readonly s3: Pick<S3Client, 'send'>,
    private readonly bucket: string,
    private readonly functionName: string,
  ) {}

  async start(roomId: string, strict = false, seconds?: number): Promise<{ jobId: string } | { unreadable: true }> {
    const event: VideoCheckEvent = { roomId, strict, ...(seconds ? { seconds } : {}) };
    const out = await this.lambda.send(new InvokeCommand({ FunctionName: this.functionName, InvocationType: 'Event', Payload: new TextEncoder().encode(JSON.stringify(event)) }));
    if (out.StatusCode !== 202) throw new Error(`the video check was not started (${out.StatusCode})`);
    return { jobId: roomId };
  }

  async result(jobId: string) {
    let text: string;
    try {
      const got = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: checkKey(jobId) }));
      text = await got.Body!.transformToString();
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return { state: 'working' } as const;
      throw e;
    }
    const v = JSON.parse(text) as { state?: string; ok?: boolean; label?: string };
    if (v.state === 'unreadable') return { state: 'unreadable' } as const;
    if (v.state === 'done' && v.ok === true) return { state: 'done', ok: true } as const;
    if (v.state === 'done' && v.ok === false) return { state: 'done', ok: false, label: v.label ?? 'unknown' } as const;
    return { state: 'failed' } as const;
  }
}
