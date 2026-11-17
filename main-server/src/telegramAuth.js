// Validates Telegram Mini App initData:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
import crypto from "node:crypto";

export function validateInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData) return null;
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(checkString).digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!authDate || (maxAgeSeconds && Date.now() / 1000 - authDate > maxAgeSeconds)) return null;

  try {
    const user = JSON.parse(params.get("user") || "{}");
    return user && typeof user.id === "number" ? user : null;
  } catch {
    return null;
  }
}
