import { callPartner } from "./partner";
import { log, warn } from "./log";

export type NotifyMessage = { orderId: string };

// Records when the confirmation went out (shown on the order page). A failure here must not resend the confirmation.
async function markNotified(env: Env, orderId: string): Promise<void> {
  try {
    await env.DB.prepare("UPDATE orders SET notified_at = ? WHERE id = ?").bind(Date.now(), orderId).run();
  } catch (e) {
    warn("could not record notification time", { orderId, error: String(e) });
  }
}

// Sends order confirmations through the partner notification API.
export async function deliver(batch: MessageBatch<NotifyMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const { orderId } = msg.body;
    try {
      const res = await callPartner(env, "/v1/notifications", { method: "POST", body: JSON.stringify({ orderId }) }, 3000);
      if (res.status === 429) {
        const after = Number(res.headers.get("retry-after")) || 1;
        warn("notification rate limited, retrying", { orderId, after });
        msg.retry({ delaySeconds: after });
        continue;
      }
      if (!res.ok) {
        warn("notification failed, retrying", { orderId, status: res.status });
        msg.retry({ delaySeconds: 2 });
        continue;
      }
      log("notification sent", { orderId });
      await markNotified(env, orderId);
      msg.ack();
    } catch (e) {
      warn("notification error, retrying", { orderId, error: String(e) });
      msg.retry({ delaySeconds: 2 });
    }
  }
}
