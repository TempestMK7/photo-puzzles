import { GetContentModerationCommand, StartContentModerationCommand, type RekognitionClient } from '@aws-sdk/client-rekognition';
import type { VideoModeration } from '../types';
import { blockedLabel, MIN_CONFIDENCE } from './rekognition';
import { mediaKey } from './s3media';

/** What Rekognition says when it will not take a video at all (as opposed to being busy): too large, or a request it cannot make sense of. */
const REFUSALS = ['VideoTooLargeException', 'InvalidParameterException'];

/**
 * Amazon Rekognition's moderation of a whole stored video (MP4 or MOV made with H.264): about ten cents a minute of video. It reads the file from the media bucket with the
 * permissions of the function that asks, runs for a minute or two, and is asked about until it is done. The same categories and confidence as for a picture turn a video down.
 */
export class RekognitionVideoModeration implements VideoModeration {
  constructor(
    private readonly client: Pick<RekognitionClient, 'send'>,
    private readonly bucket: string,
  ) {}

  async start(roomId: string): Promise<{ jobId: string } | { unreadable: true }> {
    try {
      // the room's id as the request's token: asking twice for the same video starts one job, not two (and costs once)
      const out = await this.client.send(new StartContentModerationCommand({ Video: { S3Object: { Bucket: this.bucket, Name: mediaKey(roomId) } }, MinConfidence: MIN_CONFIDENCE, ClientRequestToken: roomId }));
      if (!out.JobId) throw new Error('Rekognition gave no job id');
      return { jobId: out.JobId };
    } catch (e) {
      if (REFUSALS.includes((e as { name?: string }).name ?? '')) return { unreadable: true };
      throw e;
    }
  }

  async result(jobId: string) {
    let next: string | undefined;
    do {
      const out = await this.client.send(new GetContentModerationCommand({ JobId: jobId, MaxResults: 1000, NextToken: next }));
      if (out.JobStatus === 'IN_PROGRESS') return { state: 'working' } as const;
      if (out.JobStatus !== 'SUCCEEDED') return { state: 'unreadable' } as const;                // FAILED: the service could not read the file (H.264 in MP4 or MOV is what it reads)
      const label = blockedLabel((out.ModerationLabels ?? []).map((d) => d.ModerationLabel).filter((l) => !!l) as never);
      if (label) return { state: 'done', ok: false, label } as const;
      next = out.NextToken;
    } while (next);
    return { state: 'done', ok: true } as const;
  }
}
