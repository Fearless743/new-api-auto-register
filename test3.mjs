import { queryCheckinStatus } from './checkin.mjs';

async function main() {
  const account = {
    username: "ul3369hzj8fn",
    password: "P@7a847a740164"
  };
  
  const headers = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0",
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: "https://ai.xem8k5.top",
    Referer: "https://ai.xem8k5.top/login",
  };

  const res = await fetch("https://ai.xem8k5.top/api/user/login", {
    method: "POST",
    headers,
    body: JSON.stringify({ username: account.username, password: account.password }),
  });

  const body = await res.json();
  console.log("login result", body);
}

main().catch(console.error);
