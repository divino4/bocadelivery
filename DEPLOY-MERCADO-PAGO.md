# Boca Delivery — Pix Mercado Pago

## O que foi preparado

- Checkout solicita e-mail quando a forma de pagamento é Pix.
- O pedido continua sendo salvo no Firestore.
- A tela do pedido passa a exibir QR Code, Pix Copia e Cola e link do Mercado Pago.
- A cobrança é criada no backend (Cloud Functions), nunca no navegador.
- O backend recalcula itens, adicionais, cupom, taxa e total usando o Firestore antes de cobrar.
- A criação usa `X-Idempotency-Key` para evitar cobranças duplicadas.
- O webhook valida `x-signature`, consulta o pagamento diretamente na API e só marca `pago=true` quando o status retornado é `approved`.
- A função grava um evento de auditoria da confirmação.

## Arquivos

- `index.html`: interface atualizada.
- `functions/index.js`: criação da cobrança e webhook.
- `functions/package.json`: dependências Node 20.
- `firebase.json`: configuração de deploy.
- `firestore.rules`: regras existentes do projeto, preservadas.

## Configuração obrigatória antes de produção

1. Acesse o projeto Firebase `boca-delivery` com uma conta autorizada e confirme que Cloud Functions está habilitado. O deploy de Functions normalmente exige o plano Blaze (cobrança por uso).
2. Na conta Mercado Pago, crie/seleciona uma aplicação e obtenha o **Access Token de produção**. Não coloque esse token no `index.html`.
3. Cadastre o webhook da aplicação para eventos de pagamento (`payment`) usando a URL:

   `https://southamerica-east1-boca-delivery.cloudfunctions.net/mercadoPagoWebhook`

4. Copie a chave secreta de assinatura gerada na configuração do webhook.
5. Na pasta raiz deste projeto, execute:

   ```bash
   firebase use boca-delivery
   firebase functions:secrets:set MP_ACCESS_TOKEN
   firebase functions:secrets:set MP_WEBHOOK_SECRET
   firebase deploy --only functions
   firebase deploy --only firestore:rules
   ```

   O CLI solicitará os valores dos segredos sem precisar gravá-los nos arquivos do projeto.
6. Publique o `index.html` atualizado no mesmo hosting/domínio do Boca Delivery. Mantenha `manifest.json`, ícones e `sw.js` existentes.
7. Faça primeiro um teste com credenciais de teste e um pagamento de teste, depois configure credenciais de produção e valide um Pix real de baixo valor.

## Atenção operacional

- O Access Token e a assinatura do webhook são segredos; nunca os envie em chat, Git ou frontend.
- A confirmação automática depende do webhook estar cadastrado na aplicação correta e de `MP_WEBHOOK_SECRET` corresponder à chave secreta dessa configuração.
- O QR Pix expira em 30 minutos. O fluxo de reemissão/expiração deve ser testado antes da publicação definitiva.
- O botão administrativo de confirmação manual continua existindo como contingência e deve ser usado somente após conferir o recebimento no extrato.
- O pacote original não continha `firebase.json`, `.firebaserc`, backend nem `firebase-bundle.js`; a configuração de deploy precisa ser conciliada com a hospedagem e a rotina atuais antes de substituir arquivos em produção.
