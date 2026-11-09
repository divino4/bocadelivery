'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const crypto = require('node:crypto');

admin.initializeApp();
setGlobalOptions({ region: 'southamerica-east1', maxInstances: 10 });

const db = admin.firestore();
const MP_ACCESS_TOKEN = defineSecret('MP_ACCESS_TOKEN');
const MP_WEBHOOK_SECRET = defineSecret('MP_WEBHOOK_SECRET');
const MP_API = 'https://api.mercadopago.com';
const cents = (value) => Math.round((Number(value) + Number.EPSILON) * 100);
const money = (value) => cents(value) / 100;

function fail(message, code = 'failed-precondition') {
  throw new HttpsError(code, message);
}

function parseExtras(raw) {
  return String(raw || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const i = line.lastIndexOf(':');
    if (i < 0) return { name: line, price: 0 };
    const price = Number(line.slice(i + 1).trim().replace(',', '.'));
    return { name: line.slice(0, i).trim(), price: Number.isFinite(price) ? price : NaN };
  });
}

async function calculateOrder(order) {
  if (!Array.isArray(order.itens) || order.itens.length < 1 || order.itens.length > 50) {
    fail('O pedido não possui itens válidos.');
  }

  const cfgSnap = await db.collection('cfg').doc('loja').get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  let subtotalCents = 0;
  const verifiedItems = [];

  for (const line of order.itens) {
    const productId = String(line.produtoId || '');
    const qty = Number(line.qtd);
    if (!productId || !Number.isInteger(qty) || qty < 1 || qty > 30) fail('Há um item inválido no pedido.');
    const productSnap = await db.collection('menu').doc(productId).get();
    if (!productSnap.exists) fail('Um produto do pedido não está mais disponível.');
    const product = productSnap.data();
    if (product.ativo === false) fail('Um produto do pedido está indisponível.');
    const baseCents = cents(product.preco);
    if (!Number.isSafeInteger(baseCents) || baseCents < 0) fail('Preço inválido no cardápio.');

    const availableExtras = parseExtras(product.extras);
    let extrasCents = 0;
    const selected = Array.isArray(line.extras) ? line.extras : [];
    if (selected.length > 20) fail('Quantidade de adicionais inválida.');
    for (const selectedName of selected) {
      const extra = availableExtras.find((item) => item.name === String(selectedName));
      if (!extra || !Number.isFinite(extra.price) || extra.price < 0) fail('Um adicional não é válido para este produto.');
      extrasCents += cents(extra.price);
    }

    const unitCents = baseCents + extrasCents;
    subtotalCents += unitCents * qty;
    verifiedItems.push({
      produtoId: productId,
      nome: String(product.nome || '').slice(0, 120),
      categoria: String(product.cat || '').slice(0, 80),
      qtd: qty,
      preco: unitCents / 100,
      extras: selected.map(String),
      obs: String(line.obs || '').slice(0, 300)
    });
  }

  let discountCents = 0;
  const couponCode = String(order.cupom || '').trim().toUpperCase();
  if (couponCode) {
    const couponSnap = await db.collection('cupons').doc(couponCode).get();
    if (!couponSnap.exists || couponSnap.data().ativo !== true) fail('O cupom deste pedido não é mais válido.');
    const coupon = couponSnap.data();
    const minCents = cents(coupon.min || 0);
    if (subtotalCents < minCents) fail('O pedido não alcança o valor mínimo do cupom.');
    if (coupon.tipo === '%') discountCents = Math.round(subtotalCents * Number(coupon.valor) / 100);
    else discountCents = cents(coupon.valor);
    if (!Number.isSafeInteger(discountCents) || discountCents < 0) fail('Desconto do cupom inválido.');
    discountCents = Math.min(discountCents, subtotalCents);
  }

  let deliveryCents = 0;
  if (order.tipo === 'entrega') {
    const regionName = String(order.regiao || order.cidade || '');
    const region = (Array.isArray(cfg.cidades) ? cfg.cidades : []).find((item) => item.nome === regionName && item.ativo === true);
    if (!region) fail('A região de entrega não está disponível.');
    deliveryCents = cents(region.taxa || 0);
    if (!Number.isSafeInteger(deliveryCents) || deliveryCents < 0) fail('Taxa de entrega inválida.');
  } else if (order.tipo !== 'retirada') {
    fail('Tipo de pedido inválido.');
  }

  const totalCents = subtotalCents - discountCents + deliveryCents;
  if (totalCents <= 0) fail('O total do pedido precisa ser maior que zero.');
  return {
    itens: verifiedItems,
    subtotal: subtotalCents / 100,
    desconto: discountCents / 100,
    taxa: deliveryCents / 100,
    total: totalCents / 100
  };
}

async function mpRequest(path, options = {}) {
  const response = await fetch(`${MP_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Mercado Pago API error', response.status, body);
    throw new Error(`Mercado Pago retornou HTTP ${response.status}.`);
  }
  return body;
}

exports.createPixPayment = onCall({ secrets: [MP_ACCESS_TOKEN] }, async (request) => {
  const orderId = String(request.data && request.data.orderId || '').trim();
  const email = String(request.data && request.data.email || '').trim().toLowerCase();
  if (!/^[A-Za-z0-9_-]{5,80}$/.test(orderId)) fail('Identificador do pedido inválido.', 'invalid-argument');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Informe um e-mail válido.', 'invalid-argument');

  const orderRef = db.collection('orders').doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) fail('Pedido não encontrado.', 'not-found');
  const order = orderSnap.data();
  if (order.pag !== 'Pix') fail('Este pedido não foi feito com Pix.');
  if (order.pago === true) fail('Este pedido já está pago.');
  if (['cancelado', 'entregue'].includes(order.status)) fail('Este pedido não aceita mais pagamento.');

  // Antes de emitir uma segunda cobrança, consulta a anterior no Mercado Pago.
  // Isso evita cobrar novamente caso o pagamento tenha sido aprovado e o webhook atrasado.
  if (order.pixPaymentId) {
    try {
      const previous = await mpRequest(`/v1/payments/${encodeURIComponent(order.pixPaymentId)}`, { method: 'GET' });
      if (previous.status === 'approved') {
        await orderRef.update({ pago: true, pixStatus: 'approved', pixApprovedAt: admin.firestore.FieldValue.serverTimestamp() });
        return { paid: true };
      }
      const expiry = order.pixExpiresAt && typeof order.pixExpiresAt.toMillis === 'function' ? order.pixExpiresAt.toMillis() : 0;
      if (expiry > Date.now() && order.pixQrCode) {
        return { reused: true, qrCode: order.pixQrCode, qrCodeBase64: order.pixQrBase64 || null, ticketUrl: order.pixTicketUrl || null };
      }
      if (['pending', 'in_process', 'authorized'].includes(previous.status) && expiry <= Date.now()) {
        fail('O Pix anterior ainda consta em processamento. Aguarde a atualização antes de gerar outra cobrança.');
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      console.error('Could not verify previous Mercado Pago payment', orderId, error);
      fail('Não foi possível verificar a cobrança Pix anterior. Tente novamente em instantes.');
    }
  }

  const verified = await calculateOrder(order);
  const candidateAttemptId = crypto.randomUUID();
  const now = Date.now();
  const lock = await db.runTransaction(async (tx) => {
    const fresh = await tx.get(orderRef);
    if (!fresh.exists) fail('Pedido não encontrado.', 'not-found');
    const current = fresh.data();
    if (current.pago === true) fail('Este pedido já está pago.');
    if (current.pixQrCode && current.pixExpiresAt && current.pixExpiresAt.toMillis() > now) {
      return { existing: true, data: current };
    }
    if (current.pixCreatingUntil && current.pixCreatingUntil.toMillis() > now) {
      fail('A cobrança Pix deste pedido está sendo criada. Aguarde alguns segundos e atualize a tela.');
    }
    const attemptId = current.pixStatus === 'error' && current.pixAttemptId && !current.pixPaymentId
      ? current.pixAttemptId
      : candidateAttemptId;
    tx.update(orderRef, {
      subtotal: verified.subtotal,
      desconto: verified.desconto,
      taxa: verified.taxa,
      total: verified.total,
      itens: verified.itens,
      pixAttemptId: attemptId,
      pixCreatingUntil: admin.firestore.Timestamp.fromMillis(now + 120000),
      pixStatus: 'creating',
      pixEmail: email
    });
    return { existing: false, attemptId };
  });

  if (lock.existing) {
    return {
      reused: true,
      qrCode: lock.data.pixQrCode,
      qrCodeBase64: lock.data.pixQrBase64 || null,
      ticketUrl: lock.data.pixTicketUrl || null
    };
  }

  const attemptId = lock.attemptId;
  try {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const payment = await mpRequest('/v1/payments', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': attemptId },
      body: JSON.stringify({
        transaction_amount: verified.total,
        description: `Pedido ${orderId} - Boca Delivery`,
        payment_method_id: 'pix',
        payer: { email },
        external_reference: orderId,
        notification_url: 'https://southamerica-east1-boca-delivery.cloudfunctions.net/mercadoPagoWebhook',
        date_of_expiration: expiresAt,
        metadata: { order_id: orderId, pix_attempt_id: attemptId }
      })
    });

    const txData = payment.point_of_interaction && payment.point_of_interaction.transaction_data || {};
    if (!payment.id || !txData.qr_code) throw new Error('Mercado Pago não retornou o QR Code Pix.');
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(orderRef);
      if (!fresh.exists || fresh.data().pixAttemptId !== attemptId || fresh.data().pago === true) return;
      tx.update(orderRef, {
        pixPaymentId: String(payment.id),
        pixQrCode: txData.qr_code,
        pixQrBase64: txData.qr_code_base64 || null,
        pixTicketUrl: txData.ticket_url || null,
        pixExpiresAt: admin.firestore.Timestamp.fromDate(new Date(expiresAt)),
        pixStatus: payment.status || 'pending',
        pixCreatingUntil: admin.firestore.FieldValue.delete(),
        pixUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return { paymentId: String(payment.id), qrCode: txData.qr_code, qrCodeBase64: txData.qr_code_base64 || null, ticketUrl: txData.ticket_url || null };
  } catch (error) {
    await orderRef.update({
      pixStatus: 'error',
      pixCreatingUntil: admin.firestore.FieldValue.delete(),
      pixErrorAt: admin.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
    console.error('createPixPayment failed', orderId, error);
    throw new HttpsError('internal', 'Não foi possível gerar o Pix agora. Tente novamente em instantes.');
  }
});

function validWebhookSignature(req, dataId) {
  const secret = MP_WEBHOOK_SECRET.value();
  const signature = String(req.get('x-signature') || '');
  const requestId = String(req.get('x-request-id') || '');
  const parts = Object.fromEntries(signature.split(',').map((part) => part.trim().split('=').map((v) => v.trim())));
  if (!secret || !parts.ts || !parts.v1 || !requestId || !dataId) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.mercadoPagoWebhook = onRequest({ secrets: [MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET] }, async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).send('Method not allowed');
  const dataId = String((req.query && req.query['data.id']) || (req.body && req.body.data && req.body.data.id) || '').trim();
  const type = String((req.query && req.query.type) || (req.body && req.body.type) || '');
  if (type && type !== 'payment') return res.status(200).send('ignored');
  if (!validWebhookSignature(req, dataId)) return res.status(401).send('Invalid signature');

  try {
    const payment = await mpRequest(`/v1/payments/${encodeURIComponent(dataId)}`, { method: 'GET' });
    const orderId = String(payment.external_reference || payment.metadata && payment.metadata.order_id || '');
    if (!orderId || payment.currency_id !== 'BRL' || payment.payment_method_id !== 'pix') return res.status(200).send('ignored');
    const orderRef = db.collection('orders').doc(orderId);
    const auditRef = db.collection('audit').doc(`mp_${String(payment.id)}`);

    await db.runTransaction(async (tx) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) return;
      const order = orderSnap.data();
      const attemptId = String(payment.metadata && payment.metadata.pix_attempt_id || '');
      if (!attemptId || order.pixAttemptId !== attemptId) return;
      if (cents(payment.transaction_amount) !== cents(order.total)) return;
      if (order.pixPaymentId && String(order.pixPaymentId) !== String(payment.id)) return;

      if (payment.status === 'approved' && order.pago !== true) {
        tx.update(orderRef, {
          pago: true,
          pixStatus: 'approved',
          pixPaymentId: String(payment.id),
          pixApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
          pixUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        tx.set(auditRef, {
          orderId,
          action: 'mercado_pago_pix_aprovado',
          paymentId: String(payment.id),
          amount: Number(payment.transaction_amount),
          actor: 'mercado_pago_webhook',
          ts: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } else if (order.pago !== true) {
        tx.update(orderRef, { pixStatus: String(payment.status || 'pending'), pixUpdatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    });
    return res.status(200).send('ok');
  } catch (error) {
    console.error('mercadoPagoWebhook failed', error);
    return res.status(500).send('Webhook processing failed');
  }
});


// Registra, em coleção separada e somente pelo servidor, a categoria real
// dos produtos no instante em que o pedido é criado. Não altera pedido nem auditoria.
function loyaltyCategory(value) {
  const normalized = String(value || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').trim().toLowerCase();
  if (normalized === 'lanches') return 'Lanches';
  if (normalized === 'refeicoes') return 'Refeições';
  return null;
}

exports.captureLoyaltyOrder = onDocumentCreated('orders/{orderId}', async (event) => {
  const order = event.data && event.data.data();
  if (!order || !order.ownerUid || !Array.isArray(order.itens) || order.itens.length < 1 || order.itens.length > 50) return;

  const orderId = event.params.orderId;
  const snapshotRef = db.collection('loyaltyOrderSnapshots').doc(orderId);
  const createdAt = new Date(order.criado || '');
  if (!Number.isFinite(createdAt.getTime())) {
    await snapshotRef.create({
      orderId, ownerUid: String(order.ownerUid), valido: false,
      motivo: 'data_pedido_invalida',
      processadoEm: admin.firestore.FieldValue.serverTimestamp()
    }).catch((error) => { if (error.code !== 6 && error.code !== 'already-exists') throw error; });
    return;
  }

  const items = [];
  let valid = true;
  for (const line of order.itens) {
    const productId = String(line.produtoId || '');
    const qty = Number(line.qtd);
    if (!productId || !Number.isInteger(qty) || qty < 1 || qty > 30) {
      valid = false;
      break;
    }
    const productSnap = await db.collection('menu').doc(productId).get();
    if (!productSnap.exists) {
      valid = false;
      break;
    }
    const actualCategory = loyaltyCategory(productSnap.data().cat);
    const submittedCategory = loyaltyCategory(line.categoria);
    // Categoria ausente ou diferente do cardápio: não concede pontos.
    if (!actualCategory || submittedCategory !== actualCategory) {
      valid = false;
      break;
    }
    items.push({ produtoId: productId, categoria: actualCategory, qtd: qty });
  }

  const record = {
    orderId,
    ownerUid: String(order.ownerUid),
    criado: admin.firestore.Timestamp.fromDate(createdAt),
    valido: valid,
    itens: valid ? items : [],
    ...(valid ? {} : { motivo: 'categoria_ausente_ou_divergente' }),
    processadoEm: admin.firestore.FieldValue.serverTimestamp()
  };
  try {
    await snapshotRef.create(record);
  } catch (error) {
    // Cloud Functions pode repetir eventos; o primeiro registro é imutável.
    if (error.code !== 6) throw error;
  }
});
