/** What the user pool wants of a password (`passwordPolicy` in infra/lib/auth-stack.ts: keep the two in step). */
export const PASSWORD_MIN = 8;

export interface PasswordRule {
  label: string;
  ok: boolean;
}

/** Each rule, and whether this password keeps it: what the sign-up page lists once the player has started a password. */
export function passwordRules(password: string): PasswordRule[] {
  return [
    { label: `At least ${PASSWORD_MIN} characters`, ok: password.length >= PASSWORD_MIN },
    { label: 'A capital letter', ok: /\p{Lu}/u.test(password) },
    { label: 'A small letter', ok: /\p{Ll}/u.test(password) },
    { label: 'A digit', ok: /\d/.test(password) },
  ];
}

export const passwordOk = (password: string): boolean => passwordRules(password).every((r) => r.ok);

/** A loose look at an e-mail address (the user pool has the last word): something, an @, something with a dot. */
export const emailLooksRight = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
