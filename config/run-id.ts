import { randomBytes } from 'node:crypto';

export function generateRunId(): string {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  const random = randomBytes(3).toString('hex');

  return `${year}-${month}-${day}_${hours}${minutes}${seconds}_${random}`;
}

export function resolvePlaywrightRunId(): string {
  if (!process.env.PLAYWRIGHT_RUN_ID) {
    process.env.PLAYWRIGHT_RUN_ID = generateRunId();
  }

  return process.env.PLAYWRIGHT_RUN_ID;
}
