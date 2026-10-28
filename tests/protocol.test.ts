import { describe, expect, it } from 'vitest';
import { CODE_LENGTH, inviteLink, isSecret, lockHeld, normalizeCode, parseInvite, secretFrom, topics } from '../src/online/protocol';

describe('codes', () => {
  it('takes five digits, however they were typed', () => {
    expect(CODE_LENGTH).toBe(5);
    expect(normalizeCode('12345')).toBe('12345');
    expect(normalizeCode(' 123 45 ')).toBe('12345');
    expect(normalizeCode('123-45')).toBe('12345');
    expect(normalizeCode('00007')).toBe('00007');
    for (const bad of ['', '1234', '123456', 'abcde', '12a45', '1.2345']) expect(normalizeCode(bad), bad).toBeNull();
  });
});

describe('invite links', () => {
  const secret = secretFrom(new Uint8Array(20).map((_, i) => i * 13));

  it('makes secrets from the alphabet that has no look-alikes', () => {
    expect(secret).toHaveLength(20);
    expect(isSecret(secret)).toBe(true);
    expect(isSecret('short')).toBe(false);
    expect(isSecret('o'.repeat(20))).toBe(false);
    expect(isSecret('A'.repeat(20))).toBe(false);
  });

  it('builds a link that parses back, and keeps the code out of anything a server sees', () => {
    const link = inviteLink('https://play.example.com/', '04821', secret);
    expect(link).toBe(`https://play.example.com/#/join/04821~${secret}`);
    expect(new URL(link).pathname).toBe('/');
    expect(new URL(link).search).toBe('');
    expect(parseInvite(link)).toEqual({ code: '04821', secret });
  });

  it('reads what a player may paste: a link, a code with its secret, a bare code', () => {
    expect(parseInvite(`  https://x.test/#/join/12345~${secret}  `)).toEqual({ code: '12345', secret });
    expect(parseInvite(`12345~${secret}`)).toEqual({ code: '12345', secret });
    expect(parseInvite('123 45')).toEqual({ code: '12345' });
    expect(parseInvite('https://x.test/#/join/12345')).toEqual({ code: '12345' });
  });

  it('refuses the rest', () => {
    for (const bad of ['', 'hello', 'https://x.test/', 'https://x.test/#/join/1234', `12345~short`, `12345~${secret}~${secret}`, 'https://x.test/#/join/']) expect(parseInvite(bad), bad).toBeNull();
  });
});

describe('topics and locks', () => {
  it('keeps each player to their own hand topic', () => {
    expect(topics.events('r1')).toBe('puzzle/r1/events');
    expect(topics.hand('r1', 'u9')).toBe('puzzle/r1/hand/u9');
    expect(topics.hands('r1')).toBe('puzzle/r1/hand/+');
  });

  it('reads a lock on the game\'s clock, which may be off from the server\'s', () => {
    const lock = { holder: 'a', gid: 1, until: 10_000 };
    expect(lockHeld(null, 0, 0)).toBe(false);
    expect(lockHeld(lock, 9_000, 0)).toBe(true);
    expect(lockHeld(lock, 10_000, 0)).toBe(false);
    expect(lockHeld(lock, 7_000, 2_500)).toBe(true);        // the game's clock is 2.5 s behind the server's
    expect(lockHeld(lock, 7_600, 2_500)).toBe(false);
  });
});
