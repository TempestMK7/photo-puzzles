import { DetectModerationLabelsCommand, type ModerationLabel, type RekognitionClient } from '@aws-sdk/client-rekognition';
import type { Moderation } from '../types';

/** How sure the service has to be of a label before the picture is turned down (a percentage). Lower turns down more, and more that is harmless. */
export const MIN_CONFIDENCE = 75;

/**
 * The kinds of picture that are turned down, by the names of Rekognition's top-level categories. Nudity that is not explicit, swimwear, alcohol, drugs, gambling and rude gestures are
 * not on the list: a family photograph from a beach must go through. A label counts if it is one of these or sits under one of them.
 */
export const BLOCKED = ['Explicit', 'Violence', 'Visually Disturbing', 'Hate Symbols'] as const;

/**
 * What a picture or video from the stock library is also turned down for (`strict`): nudity that is not explicit but is nudity (implied nudity, partly bare buttocks or breast, intimate parts
 * hidden only by a hand or an object). Stock sites allow some nudity, which a family's own photographs hardly ever have. These are the labels themselves (the third level of Rekognition's list),
 * and not the category above them, which also holds a kiss on the lips, a bare back and a bare chest: those are allowed, as are swimwear and underwear.
 */
export const STRICT_ALSO = ['Implied Nudity', 'Partially Exposed Buttocks', 'Partially Exposed Female Breast', 'Obstructed Intimate Parts'] as const;

/** The first label that is on the list, as "Category / Name" (nothing if the picture may go through). */
export function blockedLabel(labels: readonly ModerationLabel[] | undefined, blocked: readonly string[] = BLOCKED, strict = false): string | undefined {
  for (const l of labels ?? []) {
    if ((l.Confidence ?? 0) < MIN_CONFIDENCE) continue;
    const top = blocked.find((b) => b === l.Name || b === l.ParentName);
    if (top) return l.Name === top ? top : `${top} / ${l.Name}`;
    if (strict && STRICT_ALSO.some((n) => n === l.Name)) return l.ParentName ? `${l.ParentName} / ${l.Name}` : l.Name;
  }
  return undefined;
}

/** Amazon Rekognition's moderation labels: about a tenth of a cent a picture, and the picture is not kept by the service. */
export class RekognitionModeration implements Moderation {
  constructor(private readonly client: Pick<RekognitionClient, 'send'>) {}

  async check(bytes: Uint8Array, _type?: string, strict = false): Promise<{ ok: true } | { ok: false; label: string }> {
    const out = await this.client.send(new DetectModerationLabelsCommand({ Image: { Bytes: bytes }, MinConfidence: MIN_CONFIDENCE }));
    const label = blockedLabel(out.ModerationLabels, BLOCKED, strict);
    return label ? { ok: false, label } : { ok: true };
  }
}
