// Builds the game's web build for the Android app and puts it where the app packs it (android/app/src/main/assets/www, which is not kept in the repository).
//
//   node scripts/android-web.mjs dev        the app talks to the dev stage (dev.puzzlevid.io's server)
//   node scripts/android-web.mjs prod       ... to the real one
//   node scripts/android-web.mjs offline    no online play at all (the game alone, and its stock library nowhere)
//
// Where the stage's server, broker and sign-in are comes from what its CloudFormation stacks say, as the Deploy workflow reads it: this needs the AWS CLI and credentials that may
// describe those stacks (set AWS_PROFILE, and on a machine whose HTTPS is intercepted AWS_CA_BUNDLE). LEGAL_OPERATOR, LEGAL_CONTACT and LEGAL_LAW (what the Deploy workflow gets from the
// repository's variables) are passed on to the privacy page and the terms in the build if they are set.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = process.argv[2] ?? '';
if (!['dev', 'prod', 'offline'].includes(stage)) {
  console.error('Say which: node scripts/android-web.mjs dev | prod | offline');
  process.exit(1);
}

/** A repository variable (what the Deploy workflow reads), or nothing if it is not set or the GitHub CLI cannot say. */
const variable = (name) => {
  try {
    return execFileSync('gh', ['variable', 'get', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }).trim();
  } catch {
    return '';
  }
};

const env = { ...process.env, VITE_BUILD: String(Math.floor(Date.now() / 1000)), VITE_STAGE: stage === 'offline' ? 'local' : stage };
if (stage !== 'offline') {
  const out = (stack, key) =>
    execFileSync('aws', ['cloudformation', 'describe-stacks', '--region', process.env.AWS_REGION ?? 'us-east-1', '--stack-name', `PuzzleVidio-${stage}-${stack}`, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`, '--output', 'text'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }).trim();
  Object.assign(env, {
    VITE_ONLINE_URL: out('Api', 'Address'),
    VITE_IOT_ENDPOINT: out('Live', 'IotEndpoint'),
    VITE_IOT_AUTHORIZER: out('Live', 'AuthorizerName'),
    VITE_COGNITO_HOST: out('Auth', 'SignInHost'),
    VITE_COGNITO_CLIENT_ID: out('Auth', 'ClientId'),
    // the Google button, when the stage has Google (the Deploy workflow's own rule: the repository's GOOGLE_CLIENT_ID and GOOGLE_SECRET_NAME are set). In the app the page opens Google in the
    // phone's browser and the player comes back (android/README.md); VITE_GOOGLE_SIGNIN=yes or no in the environment decides otherwise.
    VITE_GOOGLE_SIGNIN: process.env.VITE_GOOGLE_SIGNIN ?? (variable('GOOGLE_CLIENT_ID') && variable('GOOGLE_SECRET_NAME') ? 'yes' : ''),
  });
  for (const [k, v] of Object.entries(env)) if (k.startsWith('VITE_') && v === '' && k !== 'VITE_GOOGLE_SIGNIN') throw new Error(`The ${stage} stage did not say ${k}: is it deployed, and are these the right credentials?`);
}

execFileSync('npx', ['vite', 'build', '--outDir', 'android/app/src/main/assets/www', '--emptyOutDir'], { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' });
console.log(`\nThe ${stage} build is in android/app/src/main/assets/www. Now build the app: see android/README.md.`);
