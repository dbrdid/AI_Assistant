import { createHash, randomBytes } from 'node:crypto';

const userId = process.argv[2];
const days = Number(process.argv[3] ?? 7);
if (!userId || !/^[a-zA-Z0-9_-]{1,64}$/.test(userId) ||
    !Number.isInteger(days) || days < 1 || days > 30) {
  console.error('Usage: npm run token:create -- USER_ID [DAYS:1-30]');
  process.exitCode = 1;
} else {
  const token = randomBytes(32).toString('base64url');
  console.log('Private client bearer token (shown once; keep out of logs/source):');
  console.log(token);
  console.log('Server AI_AUTH_TOKENS array entry:');
  console.log(JSON.stringify({
    userId,
    sha256: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
  }));
}
