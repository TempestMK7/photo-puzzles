import { describe, expect, it } from 'vitest';
import { appVersion, versionLabel } from '../src/version';

describe('the version of the build', () => {
  it('has what vite.config.ts puts in: the version of package.json, and the other parts', () => {
    const v = appVersion();
    expect(v.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(v.stage).toBe('local');                                    // a build that no deploy made
    expect(Number.isNaN(Date.parse(v.built))).toBe(false);
    expect(typeof v.build).toBe('string');
    expect(typeof v.commit).toBe('string');
  });

  it('says it in a short line: the version, the build number and the commit of a deploy, and the stage unless it is the real one', () => {
    expect(versionLabel({ version: '0.3.0', build: '57', commit: 'a1b2c3d', stage: 'dev', built: '' })).toBe('v0.3.0 · build 57 · a1b2c3d · dev');
    expect(versionLabel({ version: '0.3.0', build: '58', commit: 'a1b2c3d', stage: 'prod', built: '' })).toBe('v0.3.0 · build 58 · a1b2c3d');
    expect(versionLabel({ version: '0.3.0', build: '', commit: 'a1b2c3d+', stage: 'local', built: '' })).toBe('v0.3.0 · a1b2c3d+ · local');
    expect(versionLabel({ version: '0.3.0', build: '', commit: '', stage: '', built: '' })).toBe('v0.3.0');
  });
});
