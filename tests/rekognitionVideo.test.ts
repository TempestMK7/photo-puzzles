import { describe, expect, it, vi } from 'vitest';
import { RekognitionVideoModeration } from '../server/src/aws/rekognitionVideo';
import { MIN_CONFIDENCE } from '../server/src/aws/rekognition';

const detection = (name: string, parent: string, confidence: number, timestamp = 1000) => ({ Timestamp: timestamp, ModerationLabel: { Name: name, ParentName: parent, Confidence: confidence } });

describe('starting the look at a stored video', () => {
  it('names the file in the media bucket, the confidence, and the room as the request\'s token (so that asking twice starts one job)', async () => {
    const send = vi.fn().mockResolvedValue({ JobId: 'job-7' });
    const look = new RekognitionVideoModeration({ send }, 'the-bucket');
    expect(await look.start('room1')).toEqual({ jobId: 'job-7' });
    expect(send.mock.calls[0][0].input).toEqual({ Video: { S3Object: { Bucket: 'the-bucket', Name: 'rooms/room1' } }, MinConfidence: MIN_CONFIDENCE, ClientRequestToken: 'room1' });
  });

  it('says "unreadable" when the service will not take the video at all, and lets anything else through to the caller (who may try again)', async () => {
    for (const name of ['VideoTooLargeException', 'InvalidParameterException']) {
      const err = Object.assign(new Error('no'), { name });
      expect(await new RekognitionVideoModeration({ send: vi.fn().mockRejectedValue(err) }, 'b').start('r')).toEqual({ unreadable: true });
    }
    for (const name of ['ThrottlingException', 'LimitExceededException', 'AccessDeniedException', 'InvalidS3ObjectException']) {
      await expect(new RekognitionVideoModeration({ send: vi.fn().mockRejectedValue(Object.assign(new Error(name), { name })) }, 'b').start('r')).rejects.toThrow(name);
    }
    await expect(new RekognitionVideoModeration({ send: vi.fn().mockResolvedValue({}) }, 'b').start('r')).rejects.toThrow(/no job id/);
  });
});

describe('asking how the look is going', () => {
  it('is "working" while it goes on, and "unreadable" when the service failed on the file', async () => {
    expect(await new RekognitionVideoModeration({ send: vi.fn().mockResolvedValue({ JobStatus: 'IN_PROGRESS' }) }, 'b').result('j')).toEqual({ state: 'working' });
    expect(await new RekognitionVideoModeration({ send: vi.fn().mockResolvedValue({ JobStatus: 'FAILED', StatusMessage: 'Unsupported codec' }) }, 'b').result('j')).toEqual({ state: 'unreadable' });
  });

  it('turns the video down for a label on the list at any moment of it, and says which', async () => {
    const send = vi.fn().mockResolvedValue({ JobStatus: 'SUCCEEDED', ModerationLabels: [detection('Swimwear or Underwear', '', 99), detection('Graphic Violence', 'Violence', 88, 61_000)] });
    expect(await new RekognitionVideoModeration({ send }, 'b').result('job-1')).toEqual({ state: 'done', ok: false, label: 'Violence / Graphic Violence' });
    expect(send.mock.calls[0][0].input).toMatchObject({ JobId: 'job-1', MaxResults: 1000 });
  });

  it('reads on through every page of the answer before it lets a video through', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ JobStatus: 'SUCCEEDED', ModerationLabels: [detection('Alcohol', '', 99)], NextToken: 'page2' })
      .mockResolvedValueOnce({ JobStatus: 'SUCCEEDED', ModerationLabels: [detection('Nazi Party', 'Hate Symbols', 90, 100_000)], NextToken: undefined });
    expect(await new RekognitionVideoModeration({ send }, 'b').result('j')).toEqual({ state: 'done', ok: false, label: 'Hate Symbols / Nazi Party' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].input).toMatchObject({ NextToken: 'page2' });
  });

  it('lets a video through that has nothing on the list (a beach, a toast), and one the service found nothing in', async () => {
    const send = vi.fn().mockResolvedValue({ JobStatus: 'SUCCEEDED', ModerationLabels: [detection('Swimwear or Underwear', '', 99), detection('Explicit', '', MIN_CONFIDENCE - 1)] });
    expect(await new RekognitionVideoModeration({ send }, 'b').result('j')).toEqual({ state: 'done', ok: true });
    expect(await new RekognitionVideoModeration({ send: vi.fn().mockResolvedValue({ JobStatus: 'SUCCEEDED' }) }, 'b').result('j')).toEqual({ state: 'done', ok: true });
  });

  it('lets a failure to ask through to the caller (who answers "busy" and is asked again)', async () => {
    await expect(new RekognitionVideoModeration({ send: vi.fn().mockRejectedValue(new Error('throttled')) }, 'b').result('j')).rejects.toThrow('throttled');
  });
});
