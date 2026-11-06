import { setTimeout as delay } from "node:timers/promises";

/** Bounded retries for read requests only; never retry publication mutations. */
export async function retryGithubRead(read, wait = delay) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt === 3 || ![500, 502, 503, 504].includes(error.status)) throw error;
      await wait(1000 * 2 ** attempt);
    }
  }
}
