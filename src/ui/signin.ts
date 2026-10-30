import type { AuthError, AuthResult, PasswordAccount } from '../online/identity';
import { emailLooksRight, passwordOk, passwordRules } from '../online/password';
import { h, svg } from './dom';

type Mode = 'signin' | 'signup' | 'code' | 'forgot' | 'reset';

const TITLES: Record<Mode, string> = { signin: 'Sign in', signup: 'Create an account', code: 'Check your e-mail', forgot: 'Forgot your password?', reset: 'Choose a new password' };

/** What to tell the player when the user pool said no. */
export function sayAuthError(error: AuthError): string {
  switch (error) {
    case 'wrong':
      return 'That e-mail address and password do not match.';
    case 'exists':
      return 'There is already an account with that e-mail address. Sign in instead.';
    case 'password':
      return 'That password is not allowed. Use the list below.';
    case 'invalid':
      return 'Check the e-mail address.';
    case 'code':
      return 'That code is not right.';
    case 'expired':
      return 'That code has run out. A new one is on its way.';
    case 'limit':
      return 'Too many tries. Wait a little and try again.';
    case 'offline':
      return 'Could not reach the sign-in service.';
    default:
      return 'That did not work. Please try again.';
  }
}

/** Google's own mark, which its button has to show (drawn here: nothing is fetched from Google to show a button). */
const GOOGLE_G =
  '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

/**
 * The game's own sign-in and sign-up pages, as a pop-up over the main screen (the user pool is called directly: see `CognitoAccount.passwords`). `ask()` opens it and says
 * whether the player is signed in when it closes. The rules for a password are only listed once the player has started one.
 */
export class SignInDialog {
  readonly el: HTMLElement;
  private body = h('form', { class: 'body', novalidate: true });
  private title = h('h2', {});
  private mode: Mode = 'signin';
  private email = '';
  private password = '';
  private name = '';
  private code = '';
  private status = h('div', { class: 'status', role: 'status' });
  private rules = h('ul', { class: 'rules', 'aria-label': 'What a password needs' });
  private busy = false;
  private done: ((signedIn: boolean) => void) | null = null;

  constructor(
    private readonly passwords: PasswordAccount,
    /** Goes to Google's sign-in page (and comes back to the game signed in), in a build whose accounts can. */
    private readonly google?: () => Promise<void>,
  ) {
    this.body.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });
    // coming back with the browser's Back button from Google's page shows this pop-up as it was left, held still: let it go
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted || !this.busy) return;
      this.busy = false;
      this.render();
    });
    this.el = h(
      'div',
      { class: 'inprogress online signin', role: 'dialog', 'aria-label': 'Sign in', hidden: true, onclick: (e: Event) => (e.target === this.el ? this.finish(false) : undefined), onkeydown: (e: KeyboardEvent) => e.key === 'Escape' && this.finish(false) },
      h('div', { class: 'card' }, h('header', {}, this.title, h('button', { type: 'button', class: 'close', onclick: () => this.finish(false) }, 'Close')), this.body),
    );
  }

  /** Opens the pop-up. True when the player has signed in (or made an account and signed in), false when they closed it first. */
  ask(note = ''): Promise<boolean> {
    this.done?.(false);
    this.mode = 'signin';
    this.password = this.code = '';
    this.el.hidden = false;
    this.render(note);
    return new Promise((resolve) => (this.done = resolve));
  }

  private finish(signedIn: boolean): void {
    this.el.hidden = true;
    this.password = '';
    const done = this.done;
    this.done = null;
    done?.(signedIn);
  }

  private go(mode: Mode, say = ''): void {
    this.mode = mode;
    this.code = '';
    this.render(say);
  }

  private field(label: string, input: HTMLInputElement): HTMLElement {
    return h('label', { class: 'field' }, h('span', {}, label), input);
  }

  private input(type: string, value: string, set: (v: string) => void, extra: Record<string, unknown> = {}): HTMLInputElement {
    const input = h('input', { type, class: 'plain', value, oninput: () => set(input.value), ...extra });
    return input;
  }

  private link(text: string, to: Mode): HTMLElement {
    return h('button', { type: 'button', class: 'link', onclick: () => this.go(to) }, text);
  }

  private render(say = ''): void {
    const m = this.mode;
    this.title.textContent = TITLES[m];
    this.status.textContent = say;
    const kids: (Node | null)[] = [];
    const emailBox = this.input('email', this.email, (v) => (this.email = v), { autocomplete: 'username', inputMode: 'email', 'aria-label': 'E-mail address' });
    const passwordBox = this.input('password', this.password, (v) => ((this.password = v), this.drawRules()), { autocomplete: m === 'signin' ? 'current-password' : 'new-password', 'aria-label': m === 'reset' ? 'New password' : 'Password' });
    const codeBox = this.input('text', this.code, (v) => (this.code = v), { autocomplete: 'one-time-code', inputMode: 'numeric', 'aria-label': 'Code from the e-mail' });
    let first: HTMLInputElement = emailBox;
    if (this.google && (m === 'signin' || m === 'signup')) kids.push(this.googleButton(m === 'signin' ? 'Sign in with Google' : 'Sign up with Google'), h('p', { class: 'or' }, 'or with an e-mail address'));
    switch (m) {
      case 'signin':
        kids.push(this.field('E-mail address', emailBox), this.field('Password', passwordBox));
        break;
      case 'signup': {
        const nameBox = this.input('text', this.name, (v) => (this.name = v), { autocomplete: 'nickname', maxLength: 24, placeholder: 'Optional', 'aria-label': 'Name other players see' });
        kids.push(this.field('E-mail address', emailBox), this.field('Password', passwordBox), this.rules, this.field('Name other players see', nameBox));
        break;
      }
      case 'code':
        kids.push(h('p', { class: 'hint' }, `We sent a code to ${this.email.trim() || 'your e-mail address'}. It can take a minute.`), this.field('Code', codeBox));
        first = codeBox;
        break;
      case 'forgot':
        kids.push(h('p', { class: 'hint' }, 'Type the e-mail address of your account. We will send a code to it.'), this.field('E-mail address', emailBox));
        break;
      case 'reset':
        kids.push(h('p', { class: 'hint' }, `We sent a code to ${this.email.trim() || 'your e-mail address'} if there is an account for it.`), this.field('Code', codeBox), this.field('New password', passwordBox), this.rules);
        first = codeBox;
        break;
    }
    const label = { signin: 'Sign in', signup: 'Create account', code: 'Confirm', forgot: 'Send the code', reset: 'Save password' }[m];
    kids.push(this.status, h('button', { type: 'submit', class: 'primary' }, label));
    const links: HTMLElement[] = [];
    if (m === 'signin') links.push(this.link('Create an account', 'signup'), this.link('Forgot your password?', 'forgot'));
    else if (m === 'code') links.push(h('button', { type: 'button', class: 'link', onclick: () => void this.resend() }, 'Send the code again'), this.link('Back', 'signin'));
    else links.push(this.link('I already have an account', 'signin'));
    kids.push(h('div', { class: 'links' }, ...links));
    this.body.replaceChildren(...kids.filter((k): k is Node => !!k));
    this.drawRules();
    window.setTimeout(() => first.focus(), 0);
  }

  private googleButton(label: string): HTMLElement {
    return h('button', { type: 'button', class: 'google', onclick: () => void this.goGoogle() }, svg(GOOGLE_G, 'mark'), label);
  }

  /** The page is taken away to Google's, and comes back signed in (or not): nothing here is waiting for the answer. */
  private async goGoogle(): Promise<void> {
    if (this.busy || !this.google) return;
    this.setBusy(true);
    this.say('Going to Google…');
    try {
      await this.google();
    } catch {
      this.setBusy(false);
      this.say('Could not start the sign-in with Google.');
    }
  }

  /** The list of what a password needs: nothing until the player has typed a character in the password box. */
  private drawRules(): void {
    this.rules.hidden = !this.password;
    this.rules.replaceChildren(...passwordRules(this.password).map((r) => h('li', { class: r.ok ? 'ok' : '' }, `${r.ok ? '✓' : '○'} ${r.label}`)));
  }

  private say(text: string): void {
    this.status.textContent = text;
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    for (const b of this.body.querySelectorAll('button')) (b as HTMLButtonElement).disabled = on;
  }

  /** Runs one step with the pop-up held still; `then` is called with the answer when it was fine, otherwise the player is told. */
  private async step(text: string, run: () => Promise<AuthResult>, then: (res: AuthResult & { ok: true }) => void | Promise<void>, onError?: (e: AuthError) => boolean): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    this.say(text);
    const res = await run();
    this.setBusy(false);
    if (res.ok) await then(res);
    else if (!onError?.(res.error)) this.say(sayAuthError(res.error));
  }

  private async submit(): Promise<void> {
    const email = this.email.trim();
    const p = this.passwords;
    switch (this.mode) {
      case 'signin':
        if (!email || !this.password) return this.say('Type your e-mail address and password.');
        return this.step(
          'Signing in…',
          () => p.signInWithPassword(email, this.password),
          () => this.finish(true),
          (error) => {
            if (error === 'unconfirmed') {
              void p.resendCode(email);
              this.go('code', 'This address has not been confirmed yet. We sent a new code.');
              return true;
            }
            if (error === 'reset') {
              this.go('forgot', 'Choose a new password: the old one cannot be used any more.');
              return true;
            }
            return false;
          },
        );
      case 'signup':
        if (!emailLooksRight(email)) return this.say('Check the e-mail address.');
        if (!passwordOk(this.password)) return this.say('That password is not allowed yet. Use the list below.');
        return this.step(
          'Making your account…',
          () => p.signUp(email, this.password, this.name),
          (res) => (res.needsCode ? this.go('code') : this.signInAfter(email)),
          (error) => {
            if (error !== 'exists') return false;
            this.go('signin', 'There is already an account with that e-mail address. Sign in, or choose a new password if you forgot it.');
            return true;
          },
        );
      case 'code':
        if (!this.code.trim()) return this.say('Type the code from the e-mail.');
        return this.step(
          'Checking the code…',
          () => p.confirmSignUp(email, this.code),
          () => this.signInAfter(email),
          (error) => {
            if (error !== 'expired') return false;
            void p.resendCode(email);
            this.say(sayAuthError('expired'));
            return true;
          },
        );
      case 'forgot':
        if (!emailLooksRight(email)) return this.say('Check the e-mail address.');
        return this.step('Sending the code…', () => p.forgotPassword(email), () => this.go('reset'));
      case 'reset':
        if (!this.code.trim()) return this.say('Type the code from the e-mail.');
        if (!passwordOk(this.password)) return this.say('That password is not allowed yet. Use the list below.');
        return this.step('Saving the password…', () => p.resetPassword(email, this.code, this.password), () => this.signInAfter(email));
    }
  }

  /** The address is confirmed (or needed no code): sign in with the password that was just chosen. */
  private async signInAfter(email: string): Promise<void> {
    if (!this.password) return this.go('signin', 'Done. Now sign in.');
    const res = await this.passwords.signInWithPassword(email, this.password);
    if (res.ok) this.finish(true);
    else this.go('signin', 'Done. Now sign in.');
  }

  private async resend(): Promise<void> {
    await this.step('Sending the code…', () => this.passwords.resendCode(this.email.trim()), () => this.say('Sent. It can take a minute.'));
  }
}
