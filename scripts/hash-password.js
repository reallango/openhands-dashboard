// Print an ADMIN_PASSWORD_HASH for a password, and optionally a new random API token.
// Usage: node scripts/hash-password.js            (asks for the password, input hidden)
//        node scripts/hash-password.js --token    (also prints a fresh API_TOKEN)
// In Docker: docker run --rm -it ghcr.io/... node scripts/hash-password.js
import crypto from 'node:crypto';
import readline from 'node:readline';

// Inline copy of src/auth.js hashPassword, so this script does not need the server's configuration.
function hashPassword(password, N = 32768, r = 8, p = 1) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt:${N}:${r}:${p}:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

function ask(prompt) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) {
      let data = '';
      process.stdin.on('data', c => (data += c));
      process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

const password = await ask('Admin password: ');
if (password.length < 10) {
  console.error('Use at least 10 characters.');
  process.exit(1);
}
console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
if (process.argv.includes('--token')) console.log(`API_TOKEN=${crypto.randomBytes(32).toString('base64url')}`);
