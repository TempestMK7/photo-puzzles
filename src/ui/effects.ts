import type { Prefs } from '../core/prefs';
import { effectsOn, onEffectsChange, setEffectsOn } from '../sounds';
import { h } from './dom';

/** The switch for the game's sound effects (not the video's sound): the same state on every screen that shows one. */
export function effectsButton(prefs: Prefs): HTMLButtonElement {
  const btn = h('button', {
    type: 'button',
    class: 'toggle effects',
    onclick: () => {
      setEffectsOn(!effectsOn());
      prefs.data.sfx = effectsOn();
      prefs.save();
    },
  });
  const refresh = (): void => {
    const on = effectsOn();
    btn.textContent = on ? '🔔 Effects' : '🔕 Effects';
    btn.title = on ? 'Sound effects are on (the sound of a video is separate)' : 'Sound effects are off (the sound of a video is separate)';
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('on', on);
  };
  onEffectsChange(refresh);
  refresh();
  return btn;
}
