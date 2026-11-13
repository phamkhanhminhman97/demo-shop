// Structured JSON logs (Workers Logs and wrangler tail).
export function log(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ msg, ...fields }));
}

export function warn(msg: string, fields: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level: "warn", msg, ...fields }));
}
