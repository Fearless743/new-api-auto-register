import { runCheckinStatusRefresh } from './checkin.mjs';

async function main() {
  await runCheckinStatusRefresh();
}

main().catch(console.error);
