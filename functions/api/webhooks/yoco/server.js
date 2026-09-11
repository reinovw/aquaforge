require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();

app.use(cors());
app.use(express.json());

// ─── Serve static HTML files ───────────────────────────────────────────────
// Railway serves from the project root by default
app.use(express.static(path.join(__dirname, 'public')));

// Named page routes
app.get('/',                (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/order/success',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'order-success.html')));
app.get('/order/cancelled', (req, res) => res.sendFile(path.join(__dirname, 'public', 'order-cancelled.html')));
app.get('/order/failed',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'order-failed.html')));

// ─── Trusted server-side price list ────────────────────────────────────────
// NEVER trust amounts sent by the browser — always recalculate here
const PRICES = { junior: 550, standard: 700, pro: 850 };

const YOUR_DOMAIN = 'https://www.aquaforge3d.co.za';

// ─── POST /api/create-checkout ─────────────────────────────────────────────
// Called by the website when the customer clicks "Pay with Yoco"
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { items = [], customer = {} } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items in order' });
    }

    // Recalculate total server-side — ignore any amount the browser sent
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
        'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`,
      },
      body: JSON.stringify({
        amount:     amountRand * 100, // total in cents
        currency:   'ZAR',
        successUrl: `${YOUR_DOMAIN}/order/success`,
        cancelUrl:  `${YOUR_DOMAIN}/order/cancelled`,
        failureUrl: `${YOUR_DOMAIN}/order/failed`,
        lineItems,
        metadata: {
          customerEmail: customer.email    || '',
          customerName:  customer.fullName || '',
          customerPhone: customer.phone    || '',
          deliveryAddress: [
            customer.address,
            customer.city,
            customer.province,
            customer.postal
          ].filter(Boolean).join(', '),
        },
      }),
    });

    const data = await yocoRes.json();

    if (!yocoRes.ok) {
      console.error('Yoco error:', data);
      return res.status(400).json({ error: 'Could not create checkout', detail: data });
    }

    // Return Yoco's redirect URL to the browser
    res.json({ redirectUrl: data.redirectUrl });

  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Server error creating checkout' });
  }
});

// ─── POST /api/webhooks/yoco ───────────────────────────────────────────────
// Yoco calls this when a payment succeeds/fails
// This is the SOURCE OF TRUTH — do NOT use successUrl to confirm payment
app.post('/api/webhooks/yoco', (req, res) => {
  const event = req.body;
  console.log('Yoco webhook:', event?.type, event?.id);

  if (event?.type === 'payment.succeeded') {
    // TODO: save the order to your database and trigger fulfilment
    // event.id          → Yoco payment ID
    // event.metadata    → customer details you passed above
    // event.amount      → amount in cents
    console.log('✅ Payment succeeded:', event.id, '— amount:', event.amount / 100, 'ZAR');
  }

  if (event?.type === 'payment.failed') {
    console.log('❌ Payment failed:', event.id);
  }

  res.sendStatus(200); // Always acknowledge Yoco's webhook
});

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`AquaForge server running on port ${PORT}`));
