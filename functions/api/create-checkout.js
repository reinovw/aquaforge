/**
 * functions/api/create-checkout.js
 * Cloudflare Pages Function — handles POST /api/create-checkout
 *
 * Cloudflare calls onRequestPost when the browser POSTs to /api/create-checkout.
 * env.YOCO_SECRET_KEY is set in the Cloudflare Pages dashboard under Settings → Environment Variables.
 */

const YOUR_DOMAIN = 'https://www.aquaforge3d.co.za';

// Server-side price list — NEVER trust amounts sent by the browser
const PRICES = { junior: 550, standard: 700, pro: 850 };

// CORS headers — allow both www and non-www versions of the domain
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Handle preflight OPTIONS request (browser sends this before POST)
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { items = [], customer = {} } = await request.json();

    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'No items in order' }, { status: 400, headers: CORS_HEADERS });
    }

    // Recalculate total server-side
    let amountRand = 0;
    const lineItems = items.map((item) => {
      const price = PRICES[item.id];
      if (!price) throw new Error('Unknown product id: ' + item.id);
      const qty = Math.max(1, parseInt(item.qty, 10) || 1);
      amountRand += price * qty;
      return {
        displayName: `${item.name} (${item.colour || 'Standard'})`,
        quantity: qty,
        pricingDetails: { price: price * 100 }, // Yoco wants cents
      };
    });

    const yocoRes = await fetch('https://payments.yoco.com/api/checkouts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.YOCO_SECRET_KEY}`,
      },
      body: JSON.stringify({
        amount:     amountRand * 100,
        currency:   'ZAR',
        successUrl: `${YOUR_DOMAIN}/order/success`,
        cancelUrl:  `${YOUR_DOMAIN}/order/cancelled`,
        failureUrl: `${YOUR_DOMAIN}/order/failed`,
        lineItems,
        metadata: {
          customerEmail:   customer.email    || '',
          customerName:    customer.fullName || '',
          customerPhone:   customer.phone    || '',
          deliveryAddress: [
            customer.address,
            customer.city,
            customer.province,
            customer.postal,
          ].filter(Boolean).join(', '),
        },
      }),
    });

    const data = await yocoRes.json();

    if (!yocoRes.ok) {
      console.error('Yoco error:', JSON.stringify(data));
      return Response.json({ error: 'Could not create checkout', detail: data }, { status: 400, headers: CORS_HEADERS });
    }

    return Response.json({ redirectUrl: data.redirectUrl }, { headers: CORS_HEADERS });

  } catch (err) {
    console.error('Checkout error:', err.message);
    return Response.json({ error: 'Server error' }, { status: 500, headers: CORS_HEADERS });
  }
}
