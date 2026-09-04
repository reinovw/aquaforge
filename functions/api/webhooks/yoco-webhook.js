/**
 * functions/api/webhooks/yoco.js
 * Cloudflare Pages Function — handles POST /api/webhooks/yoco
 *
 * Yoco calls this endpoint when a payment succeeds or fails.
 * This is the SOURCE OF TRUTH for confirming a paid order —
 * never rely on successUrl alone, as customers can land there without paying.
 *
 * Register this URL in Yoco dashboard:
 *   Sales → Payment Gateway → Webhooks → Add Webhook
 *   URL: https://www.aquaforge3d.co.za/api/webhooks/yoco
 *   Event: payment.succeeded
 */

export async function onRequestPost(context) {
  const { request } = context;

  try {
    const event = await request.json();
    console.log('Yoco webhook received:', event?.type, event?.id);

    if (event?.type === 'payment.succeeded') {
      // ✅ Payment confirmed — safe to fulfil the order
      // event.id              → Yoco payment ID (store this)
      // event.amount          → amount in cents
      // event.metadata        → customer details you passed at checkout
      console.log(
        '✅ Payment succeeded:',
        event.id,
        '— R' + (event.amount / 100),
        '— Customer:', event.metadata?.customerName
      );

      // TODO: Save the order to a database (Cloudflare D1, Supabase, Firebase, etc.)
      // TODO: Send a confirmation email via SendGrid / Mailgun
      // TODO: Notify yourself via WhatsApp / email that an order came in
    }

    if (event?.type === 'payment.failed') {
      console.log('❌ Payment failed:', event.id);
      // TODO: optionally notify yourself or log to a database
    }

    // Always return 200 to acknowledge receipt — Yoco will retry if you don't
    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return new Response('Error', { status: 500 });
  }
}
