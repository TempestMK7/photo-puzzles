/**
 * The address of the online server, or '' when this build has none: then nothing about playing with friends shows. `npm run dev` looks for the local server on this machine
 * (`npm run server`); a build for a real server says where it is with VITE_ONLINE_URL.
 */
export function onlineBase(): string {
  const set = import.meta.env.VITE_ONLINE_URL as string | undefined;
  if (set) return set.replace(/\/+$/, '');
  return import.meta.env.DEV ? `http://${window.location.hostname}:8787` : '';
}

/** The colours of the players, by the number the server gave each (the same on every screen). */
export const PLAYER_COLORS = ['#ffd84a', '#4ac8ff', '#ff6b6b', '#7dff7d', '#ff9be8', '#ffa24a', '#b69bff', '#a0ffe0'];
