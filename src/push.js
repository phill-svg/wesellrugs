// Web Push helpers (VAPID). Payload-less "tickle" pushes — the service worker
// fetches the latest unread info to build the notification, so we avoid the
// aes128gcm payload-encryption dance while still showing useful content.

function b64urlEncode(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const SUBJECT = "mailto:hello@wesellrugs.com.au";

// Get (or lazily create + persist) the server's VAPID keypair, stored in D1.
export async function getVapidKeys(db) {
  const row = await db.prepare("SELECT value FROM app_config WHERE key = 'vapid'").first();
  if (row) return JSON.parse(row.value);
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const publicRaw = await crypto.subtle.exportKey("raw", kp.publicKey); // 65-byte uncompressed point
  const value = { publicKeyB64: b64urlEncode(publicRaw), privateJwk };
  await db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('vapid', ?)").bind(JSON.stringify(value)).run();
  return value;
}

async function signVapidJwt(privateJwk, audience) {
  const enc = (o) => b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT };
  const signingInput = enc(header) + "." + enc(payload);
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  return signingInput + "." + b64urlEncode(sig);
}

// Send a payload-less push to one subscription endpoint. Returns HTTP status.
export async function sendPush(endpoint, vapid) {
  const audience = new URL(endpoint).origin;
  const jwt = await signVapidJwt(vapid.privateJwk, audience);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapid.publicKeyB64}`,
      TTL: "2419200",
      "Content-Length": "0",
      Urgency: "high",
    },
  });
  return res.status;
}
