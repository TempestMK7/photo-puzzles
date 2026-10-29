/**
 * The address of the online server, or '' when this build has none: then nothing about playing with friends shows. `npm run dev` looks for the local server on this machine
 * (`npm run server`); a build for a real server says where it is with VITE_ONLINE_URL.
 */
export function onlineBase(): string {
  const set = import.meta.env.VITE_ONLINE_URL as string | undefined;
  if (set) return set.replace(/\/+$/, '');
  return import.meta.env.DEV ? `http://${window.location.hostname}:8787` : '';
}

/** What a build for the real thing says about where everything is (see `.github/workflows/deploy.yml`): the API, the live broker, and the sign-in pages. */
export interface CloudConfig {
  api: string;
  iotEndpoint: string;
  iotAuthorizer: string;
  cognitoHost: string;
  cognitoClientId: string;
}

/** The cloud's settings, or nothing when this build does not have all of them (then it is the local server, or no online play at all). */
export function cloudConfig(): CloudConfig | null {
  const get = (name: string): string => String((import.meta.env as Record<string, unknown>)[name] ?? '').trim();
  const api = get('VITE_ONLINE_URL');
  const iotEndpoint = get('VITE_IOT_ENDPOINT');
  const iotAuthorizer = get('VITE_IOT_AUTHORIZER');
  const cognitoHost = get('VITE_COGNITO_HOST');
  const cognitoClientId = get('VITE_COGNITO_CLIENT_ID');
  if (!api || !iotEndpoint || !iotAuthorizer || !cognitoHost || !cognitoClientId) return null;
  return { api: api.replace(/\/+$/, ''), iotEndpoint, iotAuthorizer, cognitoHost: cognitoHost.replace(/\/+$/, ''), cognitoClientId };
}

/** The colours of the players, by the number the server gave each (the same on every screen). */
export const PLAYER_COLORS = ['#ffd84a', '#4ac8ff', '#ff6b6b', '#7dff7d', '#ff9be8', '#ffa24a', '#b69bff', '#a0ffe0'];
