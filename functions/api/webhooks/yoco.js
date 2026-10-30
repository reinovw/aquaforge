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
  const data = await res.json();
  // e.g. "Orders!A7:L7" → row 7
  const match = /![A-Z]+(\d+)/.exec(data.updates?.updatedRange || '');
  return match ? parseInt(match[1], 10) : null;
}
 
// If Yoco delivered the same event twice at the same moment, both requests can
// pass the duplicate check before either has written. After writing, each
// request looks again: if an EARLIER row already has this event ID, it deletes
// its own row. The first row always survives, so exactly one entry remains.
async function removeSelfIfDuplicate(token, sheetId, eventId, myRow) {
  if (!myRow) return false;
 
  const valsRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent('Orders!B:B')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!valsRes.ok) return false;
  const values = (await valsRes.json()).values || [];
  const firstRow = values.findIndex((r) => r[0] === eventId) + 1; // 1-based
  if (!firstRow || firstRow >= myRow) return false; // we are the first entry — keep it
 
  // Find the numeric id of the "Orders" tab (needed to delete a row)
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const tab = ((await metaRes.json()).sheets || []).find((s) => s.properties.title === 'Orders');
  if (!tab) return false;
 
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: { sheetId: tab.properties.sheetId, dimension: 'ROWS', startIndex: myRow - 1, endIndex: myRow },
        },
      }],
    }),
  });
  console.log(`Removed duplicate row ${myRow} for ${eventId} (kept row ${firstRow})`);
  return true;
}
 
// ─── Order confirmation email (via Resend) ─────────────────────────────────
 
const ORDER_FROM   = 'AquaForge <orders@aquaforge3d.co.za>';
const ORDER_TEAM   = ['reinovw@live.com', 'gideon@playersswim.co.za'];
 
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
 
function buildEmailHtml(order) {
  const firstName = esc((order.customerName || '').split(' ')[0] || 'there');
  const isPickup  = /pickup/i.test(order.shippingMethod || '');
  const items     = (order.items || '').split(', ').filter(Boolean)
    .map((i) => `<li style="margin:4px 0;">${esc(i)}</li>`).join('');
 
  const deliveryNote = isPickup
    ? `<p style="margin:0 0 6px;"><strong>Collection:</strong> LC de Villiers Pool, University of Pretoria, Hatfield</p>
       <p style="margin:0;color:#5b6b85;">We'll contact you on ${esc(order.customerPhone)} to arrange a collection time.</p>`
    : `<p style="margin:0 0 6px;"><strong>Courier delivery to:</strong><br>${esc(order.deliveryAddress)}</p>
       <p style="margin:0;color:#5b6b85;">We'll be in touch with tracking details once your order ships.</p>`;
 
  return `<!doctype html><html><body style="margin:0;background:#eef2f7;font-family:Arial,Helvetica,sans-serif;color:#0d1422;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#080C16;padding:24px 28px;">
        <div style="font-size:22px;font-weight:900;color:#ffffff;letter-spacing:1px;">AquaForge</div>
        <div style="font-size:11px;color:#2BD9CB;letter-spacing:2px;margin-top:4px;">3D PRINTED SWIM GEAR</div>
      </td></tr>
      <tr><td style="padding:28px;">
        <h1 style="font-size:20px;margin:0 0 12px;">Thanks for your order, ${firstName}!</h1>
        <p style="margin:0 0 20px;line-height:1.6;">Your payment has been received and your order is confirmed. Here are your details:</p>
 
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fb;border-radius:8px;">
          <tr><td style="padding:16px 18px;">
            <div style="font-size:12px;color:#5b6b85;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Items</div>
            <ul style="margin:0 0 14px;padding-left:18px;">${items || '<li>See your Yoco receipt</li>'}</ul>
            <div style="font-size:12px;color:#5b6b85;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Delivery</div>
            <div style="margin-bottom:14px;line-height:1.5;">${deliveryNote}</div>
            <div style="border-top:1px solid #dde3ec;padding-top:12px;font-size:18px;font-weight:900;">
              Total paid: <span style="color:#0f9f93;">${esc(order.amount)}</span>
            </div>
          </td></tr>
        </table>
 
        <p style="margin:20px 0 6px;font-size:13px;color:#5b6b85;">Payment reference: ${esc(order.id)}</p>
        <p style="margin:0 0 20px;font-size:13px;color:#5b6b85;">Your AquaForge prop is covered by a 6-month warranty against manufacturing defects. Keep this email as your proof of purchase.</p>
 
        <p style="margin:0;line-height:1.6;">Questions? Just reply to this email.</p>
        <p style="margin:16px 0 0;">Drag more. Swim stronger.<br><strong>The AquaForge team</strong></p>
      </td></tr>
      <tr><td style="background:#f5f7fb;padding:16px 28px;font-size:11px;color:#8090a8;text-align:center;">
        Players Swim (Pty Ltd) · www.aquaforge3d.co.za
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}
 
async function sendConfirmationEmail(env, order) {
  if (!env.RESEND_API_KEY) { console.log('RESEND_API_KEY not set — skipping email'); return; }
 
  const to  = order.customerEmail ? [order.customerEmail] : ORDER_TEAM;
  const bcc = order.customerEmail ? ORDER_TEAM : [];
 
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: ORDER_FROM,
      to,
      bcc,
      reply_to: ORDER_TEAM[0],
      subject: `AquaForge order confirmed — ${order.amount}`,
      html: buildEmailHtml(order),
    }),
  });
  if (!res.ok) throw new Error(`Resend failed (${res.status}): ${await res.text()}`);
  console.log('Confirmation email sent to', to.join(', '));
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
 
    // Small random pause so two simultaneous deliveries don't check at the exact same instant
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 1500)));
 
    if (await alreadyLogged(token, env.GOOGLE_SHEET_ID, eventId)) {
      console.log('Duplicate event, skipping:', eventId);
      return ok();
    }
 
    const myRow = await appendRow(token, env.GOOGLE_SHEET_ID, row);
    const wasDuplicate = await removeSelfIfDuplicate(token, env.GOOGLE_SHEET_ID, eventId, myRow);
    if (wasDuplicate) return ok(); // the other delivery handles the email
 
    console.log('Order logged:', eventId);
 
    try {
      await sendConfirmationEmail(env, {
        id: payload.id || eventId,
        amount,
        customerName:    meta.customerName,
        customerEmail:   meta.customerEmail,
        customerPhone:   meta.customerPhone,
        items:           meta.orderItems,
        shippingMethod:  meta.shippingMethod,
        deliveryAddress: meta.deliveryAddress,
      });
    } catch (e) {
      console.error('Email error:', e.message);
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
 
  // Always 200 so Yoco doesn't keep retrying
  return ok();
}
