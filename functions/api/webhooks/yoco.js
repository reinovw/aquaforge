/**
 * functions/api/webhooks/yoco.js
 * Cloudflare Pages Function — handles POST /api/webhooks/yoco
 *
 * When Yoco confirms a payment, this function:
 *   1. Logs the order as a new row in your Google Sheet
 *   2. Returns 200 to acknowledge receipt (Yoco retries if it doesn't get 200)
 *
 * Cloudflare Environment Variables required (Settings → Environment Variables):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL   → the service account email from your Google Cloud JSON key
 *   GOOGLE_PRIVATE_KEY             → the private_key value from your Google Cloud JSON key
 *   GOOGLE_SHEET_ID                → the long ID from your Google Sheet URL
 *
 * Register this webhook URL in Yoco:
 *   Developers → Webhooks → Add Webhook
 *   URL: https://www.aquaforge3d.co.za/api/webhooks/yoco
 *   Event: payment.succeeded
 */

// ─── Google Sheets Auth ────────────────────────────────────────────────────
// Cloudflare Workers support Web Crypto API — we use it to sign a JWT
// and exchange it for a Google access token (no Node.js needed)

async function getGoogleAccessToken(email, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);

  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss:   email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };

  // base64url encode (no padding, url-safe chars)
  const b64url = obj =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

  const signingInput = `${b64url(header)}.${b64url(payload)}`;

  // Strip PEM headers/whitespace and decode to bytes
  const pemClean = privateKeyPem
    .replace(/-----BEGIN.*?-----/, '')
    .replace(/-----END.*?-----/, '')
    .replace(/\s+/g, '');

  const keyBytes = Uint8Array.from(atob(pemClean), c => c.charCodeAt(0));

  // Import as PKCS#8 RSA key for signing
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Sign the JWT
  const sigBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const jwt = `${signingInput}.${sig}`;

  // Exchange JWT for a short-lived Google access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Failed to get Google token: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ─── Append a row to Google Sheets ────────────────────────────────────────

async function logOrderToSheet(env, order) {
  const token = await getGoogleAccessToken(
    env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    env.GOOGLE_PRIVATE_KEY
  );

  const sheetId  = env.GOOGLE_SHEET_ID;
  const range    = 'Orders!A:L'; // Columns A through L — matches the row array below
  const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED`;

  const now = new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });

  // One row per order — columns match the header row you'll set up in your sheet
  const row = [
    now,                                    // A: Date & Time (SAST)
    order.id,                               // B: Yoco Payment ID
    order.customerName  || '',              // C: Customer Name
    order.customerEmail || '',              // D: Email
    order.customerPhone || '',              // E: Phone
    order.items         || '',              // F: Items ordered
    order.shippingMethod || '',             // G: Shipping / Pickup
    order.deliveryAddress || '',            // H: Delivery Address
    `R${(order.amount / 100).toFixed(2)}`,  // I: Amount paid
    'PAID',                                 // J: Status
    order.id,                               // K: Yoco ID (duplicate for easy lookup)
    '',                                     // L: Notes (fill in manually)
  ];

  const res = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ values: [row] }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Google Sheets append failed: ' + err);
  }

  console.log('✅ Order logged to Google Sheet:', order.id);
}

// ─── Main webhook handler ──────────────────────────────────────────────────

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const event = await request.json();
    console.log('Yoco webhook received:', event?.type, event?.id);

    if (event?.type === 'payment.succeeded') {
      const meta = event.metadata || {};

      const order = {
        id:              event.id,
        amount:          event.amount,             // in cents
        customerName:    meta.customerName  || '',
        customerEmail:   meta.customerEmail || '',
        customerPhone:   meta.customerPhone || '',
        shippingMethod:  meta.shippingMethod === 'pickup'
                           ? 'Pickup – LC de Villiers Pool'
                           : 'Courier – R150',
        deliveryAddress: meta.deliveryAddress || 'N/A (Pickup)',
        items:           meta.items           || '',
      };

      console.log('✅ Payment succeeded:', order.id, '— R' + (order.amount / 100));

      // Log to Google Sheets
      await logOrderToSheet(env, order);
    }

    if (event?.type === 'payment.failed') {
      console.log('❌ Payment failed:', event.id);
    }

    // Always return 200 — Yoco retries if it doesn't receive this
    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('Webhook error:', err.message);
    // Still return 200 so Yoco doesn't keep retrying a genuine sheet error
    return new Response('OK', { status: 200 });
  }
}
