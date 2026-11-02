import { GENERAL, generalValue } from '../core/kinds';
import type { Prefs } from '../core/prefs';
import { effectsOn, effectsVolume, playEffect, setEffectsOn, setEffectsVolume } from '../sounds';
import { h } from './dom';

/** Opens the settings window over whatever screen is showing; `changed` is called after each change, so that the screen can look at the settings again. */
export function openSettings(prefs: Prefs, changed: () => void = () => {}): void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const close = (): void => {
    window.removeEventListener('keydown', onKey, true);
    root.remove();
    previous?.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();                                       // (the screen under the window does not take Escape for itself)
    close();
  };
  const check = (label: string, on: boolean, set: (on: boolean) => void): HTMLElement =>
    h(
      'label',
      { class: 'field check' },
      h('input', {
        type: 'checkbox',
        checked: on,
        onchange: (ev: Event) => {
          set((ev.target as HTMLInputElement).checked);
          prefs.save();
          changed();
        },
      }),
      h('span', {}, label),
    );
  const root = h(
    'div',
    { class: 'inprogress settings', role: 'dialog', 'aria-label': 'Settings', onclick: (e: Event) => (e.target === root ? close() : undefined) },
    h(
      'div',
      { class: 'card' },
      h('header', {}, h('h2', {}, 'Settings'), h('button', { type: 'button', class: 'close', onclick: close }, 'Close')),
      h(
        'div',
        { class: 'body' },
        // (the box says "mute", the setting says "on")
        check('Mute sound effects', !effectsOn(), (muted) => {
          setEffectsOn(!muted);
          prefs.data.sfx = !muted;
        }),
        h(
          'label',
          { class: 'field' },
          h('span', {}, 'Sound effects volume ', h('output', {}, `${Math.round(effectsVolume() * 100)}%`)),
          h('input', {
            type: 'range',
            min: 0,
            max: 100,
            step: 5,
            value: Math.round(effectsVolume() * 100),
            'aria-label': 'Sound effects volume',
            // (100% is as loud as the effects can be, and they start at 50%)
            oninput: (ev: Event) => {
              const v = Number((ev.target as HTMLInputElement).value);
              setEffectsVolume(v / 100);
              prefs.data.sfxVolume = v / 100;
              const out = (ev.target as HTMLElement).parentElement?.querySelector('output');
              if (out) out.textContent = `${v}%`;
            },
            onchange: () => {
              prefs.save();
              playEffect('pickup');                                // (so that it can be heard)
            },
          }),
        ),
        ...GENERAL.map((o) =>
          check(o.label, generalValue(prefs.data.settings, o.key) !== 0, (on) => {
            prefs.data.settings[`all.${o.key}`] = on ? 1 : 0;
          }),
        ),
        h('p', { class: 'note' }, 'These hold for every kind of puzzle. The sound of a video is set with its own button.'),
      ),
    ),
  );
  window.addEventListener('keydown', onKey, true);
  document.body.append(root);
  root.querySelector<HTMLElement>('input')?.focus();
}

/** The header button that opens the settings window. */
export function settingsButton(prefs: Prefs, changed?: () => void): HTMLButtonElement {
  return h('button', { type: 'button', class: 'toggle settings-btn', title: 'Settings', 'aria-label': 'Settings', onclick: () => openSettings(prefs, changed) }, '⚙ Settings');
}
