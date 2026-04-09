import { queryCheckinStatus } from './checkin.mjs';

async function main() {
  const account = {
    username: "ul3369hzj8fn",
    session: "session=MTc3MzAzNzI1NHxEWDhFQVFMX2dBQUJFQUVRQUFEX2xfLUFBQVVHYzNSeWFXNW5EQVFBQW1sa0EybHVkQVFFQVA0U0VnWnpkSEpwYm1jTUNnQUlkWE5sY201aGJXVUdjM1J5YVc1bkRBNEFESFZzTXpNMk9XaDZhamhtYmdaemRISnBibWNNQmdBRWNtOXNaUU5wYm5RRUFnQUNCbk4wY21sdVp3d0lBQVp6ZEdGMGRYTURhVzUwQkFJQUFnWnpkSEpwYm1jTUJ3QUZaM0p2ZFhBR2MzUnlhVzVuREFrQUIyUmxabUYxYkhRPXyJP7Rk3V5Yvb2inSBCpWK1VzWyPqHBVn0IaB8uljFGdw=="
  };
  const result = await queryCheckinStatus(account);
  console.log(result);
}

main().catch(console.error);
