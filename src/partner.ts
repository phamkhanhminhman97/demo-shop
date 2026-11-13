// Client for the partner API (payments, notifications, pricing), operated by another company.
export async function callPartner(env: Env, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(env.PARTNER_URL + path, {
    ...init,
    headers: { authorization: `Bearer ${env.PARTNER_KEY}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
}
