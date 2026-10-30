import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudConfig } from '../src/online/config';

afterEach(() => vi.unstubAllEnvs());

const cloud = () => {
  vi.stubEnv('VITE_ONLINE_URL', 'https://api.example/');
  vi.stubEnv('VITE_IOT_ENDPOINT', 'iot.example');
  vi.stubEnv('VITE_IOT_AUTHORIZER', 'auth');
  vi.stubEnv('VITE_COGNITO_HOST', 'https://pool.example/');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'client');
};

describe('what a build knows about the cloud', () => {
  it('has no Google unless the deploy says so', () => {
    cloud();
    expect(cloudConfig()).toMatchObject({ api: 'https://api.example', cognitoHost: 'https://pool.example', google: false });
    vi.stubEnv('VITE_GOOGLE_SIGNIN', '');
    expect(cloudConfig()?.google).toBe(false);
    vi.stubEnv('VITE_GOOGLE_SIGNIN', 'yes');
    expect(cloudConfig()?.google).toBe(true);
  });

  it('is nothing when one of the settings is missing', () => {
    cloud();
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', '');
    expect(cloudConfig()).toBeNull();
  });
});
