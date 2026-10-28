/**
 * functions/api/webhooks/yoco.js
 * Cloudflare Pages Function — handles POST /api/webhooks/yoco
 * Enhanced with step-by-step logging for debugging
 */

async function getGoogleAccessToken(email, privateKeyPem) {
  console.log('🔑 Getting Google access token for:', email);

  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss:   email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };

  const b64url = obj =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

  const signingInput = `${b64url(header)}.${b64url(payload)}`;

  // The private key from Google sometimes has literal \n instead of real newlines
  // This handles both cases
  const pemNormalized = privateKeyPem.replace(/\\n/g, '\n');

  const pemClean = pemNormalized
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
    .replace(/-----END RSA PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');

  console.log('🔑 PEM clean length:', pemClean.length);

  let keyBytes;
  try {
    keyBytes = Uint8Array.from(atob(pemClean), c => c.charCodeAt(0));
  } catch(e) {
    throw new Error('Failed to decode PEM key — check GOOGLE_PRIVATE_KEY format: ' + e.message);
  }

  let cryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      keyBytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  } catch(e) {
    throw new Error('Failed to import crypto key: ' + e.message);
  }

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
  console.log('🔑 JWT created, exchanging for access token...');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  console.log('🔑 Token response status:', tokenRes.status, '— has token:', !!tokenData.access_token);

  if (!tokenData.access_token) {
    throw new Error('Failed to get Google token: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

async function logOrderToSheet(env, order) {
  // Check env vars exist
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL) throw new Error('Missing env: GOOGLE_SERVICE_ACCOUNT_EMAIL');
  if (!env.GOOGLE_PRIVATE_KEY)           throw new Error('Missing env: GOOGLE_PRIVATE_KEY');
  if (!env.GOOGLE_SHEET_ID)              throw new Error('Missing env: GOOGLE_SHEET_ID');

  console.log('📊 Logging to sheet ID:', env.GOOGLE_SHEET_ID);
  console.log('📊 Service account:', env.GOOGLE_SERVICE_ACCOUNT_EMAIL);

  const token    = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_PRIVATE_KEY);
  const sheetId  = env.GOOGLE_SHEET_ID;
  const range    = 'Orders!A:L';
  const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const now = new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });

  const row = [
    now,
    order.id,
    order.customerName   || '',
    order.customerEmail  || '',
    order.customerPhone  || '',
    order.items          || '',
    order.shippingMethod || '',
    order.deliveryAddress|| '',
    order.amount,
    'PAID',
    order.id,
    '',
  ];

  console.log('📊 Appending row to sheet, range:', range);
  console.log('📊 Row data:', JSON.stringify(row));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ values: [row] }),
  });

  const resText = await res.text();
  console.log('📊 Sheets API response status:', res.status);
  console.log('📊 Sheets API response body:', resText);

  if (!res.ok) {
    throw new Error(`Google Sheets append failed (${res.status}): ${resText}`);
  }

  console.log('✅ Order logged to Google Sheet successfully:', order.id);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  console.log('📥 Webhook received at:', new Date().toISOString());

  try {
    const rawBody = await request.text();
    console.log('📥 Raw webhook body:', rawBody.substring(0, 500));

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch(e) {
      console.error('❌ Failed to parse webhook JSON:', e.message);
      return new Response('OK', { status: 200 });
    }

    console.log('📥 Event type:', event?.type, '— ID:', event?.id);
    console.log('📥 Metadata:', JSON.stringify(event?.metadata || {}));

    if (event?.type === 'payment.succeeded') {
      const meta = event.metadata || {};

      // Deduplicate — Yoco sometimes sends the same event twice
      // We track the last processed ID in a global variable for this worker instance
      if (global._lastProcessedId === event.id) {
        console.log('⚠️ Duplicate event detected, skipping:', event.id);
        return new Response('OK', { status: 200, headers: CORS_HEADERS });
      }
      global._lastProcessedId = event.id;

      // Yoco sends amount in cents — convert to Rand
      // Use our stored orderTotal from metadata as the source of truth if available
      const amountRand = meta.orderTotal || `R${((event.amount || 0) / 100).toFixed(2)}`;

      const order = {
        id:              event.id                || '',
        amount:          amountRand,
        customerName:    meta.customerName       || '',
        customerEmail:   meta.customerEmail      || '',
        customerPhone:   meta.customerPhone      || '',
        shippingMethod:  meta.shippingMethod     || '',
        deliveryAddress: meta.deliveryAddress    || '',
        items:           meta.orderItems         || '',
      };

      console.log('✅ Payment succeeded — logging order:', JSON.stringify(order));
      await logOrderToSheet(env, order);

    } else {
      console.log('ℹ️ Event type not handled:', event?.type);
    }

    return new Response('OK', { status: 200, headers: CORS_HEADERS });

  } catch (err) {
    console.error('❌ Webhook handler error:', err.message);
    console.error('❌ Stack:', err.stack);
    return new Response('OK', { status: 200, headers: CORS_HEADERS });
  }
}

