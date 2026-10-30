/**
 * functions/api/webhooks/yoco.js
 * Cloudflare Pages Function — handles POST /api/webhooks/yoco
 *
 * On payment.succeeded it appends one row to the "Orders" tab of your Google Sheet.
 *
 * Environment variables (Cloudflare → Settings → Environment Variables):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_ID, YOCO_SECRET_KEY
 *
 * Sheet columns (row 1 headers):
 *   A Date & Time | B Event ID | C Name | D Email | E Phone | F Items |
 *   G Shipping | H Address | I Amount | J Status | K Payment ID | L Notes
 *
 * If a row arrives without customer details, column L (Notes) holds the raw
 * webhook body so the problem can be diagnosed without needing Cloudflare logs.
 */
 
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
 
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
 
// ─── Google auth (service account JWT → access token) ──────────────────────
 
async function getGoogleAccessToken(email, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const b64url = (obj) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
 
  const signingInput =
    b64url({ alg: 'RS256', typ: 'JWT' }) + '.' +
    b64url({
      iss: email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    });
 
  // Cloudflare stores the key with literal "\n" — convert to real newlines first
  const pemClean = privateKeyPem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/, '')
    .replace(/-----END (RSA )?PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
 
  const keyBytes = Uint8Array.from(atob(pemClean), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput)
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
 
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${signingInput}.${sig}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('Google token failed: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}
 
// ─── Sheet helpers ─────────────────────────────────────────────────────────
 
async function alreadyLogged(token, sheetId, eventId) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent('Orders!B:B')}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return false;
  const data = await res.json();
  return (data.values || []).some((r) => r[0] === eventId);
}
 
async function appendRow(token, sheetId, row) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent('Orders!A:L')}` +
    `:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`Sheets append failed (${res.status}): ${await res.text()}`);
}
 
// ─── Webhook handler ───────────────────────────────────────────────────────
 
export async function onRequestPost({ request, env }) {
  const ok = () => new Response('OK', { status: 200, headers: CORS_HEADERS });
 
  try {
    const rawBody = await request.text();
    const event = JSON.parse(rawBody);
    console.log('Webhook received:', event.type, event.id);
 
    if (event.type !== 'payment.succeeded') return ok();
 
    // Yoco nests the payment under "payload"; fall back for other shapes
    const payload = event.payload || event.data || {};
    let meta = payload.metadata || event.metadata || {};
 
    // If our order details are missing, look the checkout up from Yoco by id
    if (!meta.customerName && meta.checkoutId && env.YOCO_SECRET_KEY) {
      try {
        const r = await fetch(`https://payments.yoco.com/api/checkouts/${meta.checkoutId}`, {
          headers: { Authorization: `Bearer ${env.YOCO_SECRET_KEY}` },
        });
        if (r.ok) {
          const checkout = await r.json();
          meta = { ...(checkout.metadata || {}), ...meta };
        }
      } catch (e) {
        console.error('Checkout lookup failed:', e.message);
      }
    }
 
    const eventId = event.id || payload.id || '';
    const cents = payload.amount ?? event.amount ?? 0;
    const amount = meta.orderTotal || `R${(cents / 100).toFixed(2)}`;
 
    // No customer details found → keep the raw body in Notes for diagnosis
    const notes = meta.customerName ? '' : 'DEBUG raw: ' + rawBody.slice(0, 3000);
 
    const row = [
      new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }),
      eventId,
      meta.customerName    || '',
      meta.customerEmail   || '',
      meta.customerPhone   || '',
      meta.orderItems      || '',
      meta.shippingMethod  || '',
      meta.deliveryAddress || '',
      amount,
      'PAID',
      payload.id || '',
      notes,
    ];
 
    const token = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_PRIVATE_KEY);
 
    if (await alreadyLogged(token, env.GOOGLE_SHEET_ID, eventId)) {
      console.log('Duplicate event, skipping:', eventId);
      return ok();
    }
 
    await appendRow(token, env.GOOGLE_SHEET_ID, row);
    console.log('Order logged:', eventId);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
 
  // Always 200 so Yoco doesn't keep retrying
  return ok();
}
