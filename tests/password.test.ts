import { describe, expect, it } from 'vitest';
import { emailLooksRight, passwordOk, passwordRules } from '../src/online/password';

describe('the rules for a password', () => {
  it('lists each rule, and which ones a password keeps', () => {
    expect(passwordRules('').map((r) => r.ok)).toEqual([false, false, false, false]);
    expect(passwordRules('abc').map((r) => r.ok)).toEqual([false, false, true, false]);
    expect(passwordRules('Abcdefg1').map((r) => r.ok)).toEqual([true, true, true, true]);
  });
  it('is fine with eight characters, a capital, a small letter and a digit, and needs no symbol', () => {
    expect(passwordOk('Abcdefg1')).toBe(true);
    expect(passwordOk('Abcdefg')).toBe(false);          // too short, and no digit
    expect(passwordOk('abcdefg1')).toBe(false);         // no capital
    expect(passwordOk('ABCDEFG1')).toBe(false);         // no small letter
    expect(passwordOk('Abcdefgh')).toBe(false);         // no digit
  });
  it('counts letters of other alphabets', () => {
    expect(passwordOk('Ünïcödé1')).toBe(true);
  });
});

describe('an e-mail address', () => {
  it('has something, an @, and a dotted name; spaces around it do not matter', () => {
    expect(emailLooksRight(' a@b.co ')).toBe(true);
    for (const bad of ['', 'a', 'a@b', '@b.co', 'a b@c.de', 'a@b@c.de']) expect(emailLooksRight(bad)).toBe(false);
  });
});
