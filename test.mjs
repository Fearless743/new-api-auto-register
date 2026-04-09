import { refreshAccountCheckinStatus } from './checkin.mjs';

async function main() {
  const result = await refreshAccountCheckinStatus("ul3369hzj8fn");
  console.log(result);
}

main().catch(console.error);
