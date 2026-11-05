# Boca Delivery — Pix Mercado Pago

Este pacote inclui o backend Firebase Cloud Functions para criar cobranças Pix por pedido e confirmar pagamentos por webhook.

## O que está incluído

- `functions/index.js`: callable `createPixPayment` e webhook `mercadoPagoWebhook`.
- `functions/package.json`: dependências do backend (Node.js 20).
- `index.html`: já chama `createPixPayment` na região `southamerica-east1` e exibe os dados Pix gravados no pedido.
- `firebase.json`, `.firebaserc` e `firestore.rules`.

O backend recalcula o valor com base no cardápio, adicionais, cupom e taxa de entrega guardados no Firestore. O token do Mercado Pago fica apenas nos secrets do Firebase. O webhook valida a assinatura, consulta o pagamento na API do Mercado Pago e só marca `pago=true` quando o status consultado é `approved` e o valor/moeda/pedido correspondem.

## Antes de publicar

1. Confirme que o projeto Firebase correto é `boca-delivery`.
2. Cloud Functions normalmente exige que o projeto esteja no plano Blaze (cobrança por uso). Consulte o custo estimado e configure alertas de orçamento.
3. No Mercado Pago, crie/seleciona a aplicação e use primeiro credenciais de teste. Nunca coloque o Access Token no HTML, GitHub ou mensagens.
4. O webhook deve receber eventos de pagamento (`payment`). A URL de produção é:

   `https://southamerica-east1-boca-delivery.cloudfunctions.net/mercadoPagoWebhook`

5. Copie a chave secreta de assinatura que o Mercado Pago fornece para esse webhook. Ela é diferente do Access Token.
6. Verifique se o e-mail `zhenburger@gmail.com` está cadastrado no Firebase Authentication, com e-mail verificado, para acesso de gestor definido nas regras.

## Publicação pelo terminal

Na pasta raiz do projeto, com o Firebase CLI instalado e autenticado:

```bash
firebase use boca-delivery
firebase functions:secrets:set MP_ACCESS_TOKEN
firebase functions:secrets:set MP_WEBHOOK_SECRET
firebase deploy --only functions
firebase deploy --only firestore:rules
```

O CLI pedirá os valores dos secrets de forma interativa. Não os escreva em arquivos nem os envie por chat. Os dois comandos de deploy são separados para facilitar a identificação de erros.

Depois que as Functions forem publicadas, cadastre/atualize o webhook no Mercado Pago com a URL acima. Publique o `index.html` atualizado no GitHub Pages. Preserve `manifest.json`, ícones, `firebase-bundle.js` e `sw.js`.

## Teste obrigatório

1. Use credenciais de teste do Mercado Pago e um usuário/conta de teste permitidos pelo Mercado Pago.
2. Crie um pedido Pix pequeno e confira se o QR Code e o Pix Copia e Cola aparecem.
3. Simule/pague o Pix de teste e confira se o pedido muda para pago automaticamente após o webhook.
4. Confira os logs das Functions e o documento do pedido no Firestore.
5. Só depois troque para credenciais de produção e faça um teste real de baixo valor.

## Observações

- O QR Code é solicitado com vencimento de 30 minutos.
- Uma tentativa de gerar outro Pix consulta a cobrança anterior antes de criar uma nova, para reduzir risco de cobrança duplicada.
- O webhook é idempotente: uma notificação repetida não deve gerar uma segunda confirmação.
- O botão administrativo de confirmação manual é contingência e só deve ser usado depois de conferir o recebimento no extrato.
- GitHub Pages hospeda o frontend estático. As Cloud Functions precisam ser implantadas separadamente no Firebase.
