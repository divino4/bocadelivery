# Boca Delivery — Worker isolado de cartão (TESTE)

Este Worker é separado do Worker de Pix em produção. Ele só processa cartão usando credenciais de teste do Mercado Pago e deve usar uma conta de serviço exclusiva do Firebase `boca-delivery-teste`.

## Segurança e isolamento

- Não implantar este arquivo com a configuração padrão `wrangler.jsonc`.
- Use sempre `--config wrangler.card-test.jsonc`.
- O nome do Worker isolado é `boca-delivery-card-test`.
- A rota `/create-pix` fica desativada neste Worker.
- O webhook só aceita `/webhook?environment=test`.
- O Worker usa somente `MP_ACCESS_TOKEN_TEST` para criar/consultar pagamentos de cartão.
- Os secrets deste Worker são independentes dos secrets do Worker de produção.
- O CORS usa origem curinga apenas neste Worker de teste, sem cookies/credenciais CORS; a API exige Firebase ID token. Antes de disponibilizar a prévia a terceiros, restringir a origem ao domínio de preview.

## Secrets que precisam ser configurados no Worker isolado

Criar/usar uma chave de conta de serviço no projeto Firebase `boca-delivery-teste` e configurar os seguintes secrets no Worker `boca-delivery-card-test`:

```sh
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT --config wrangler.card-test.jsonc
npx wrangler secret put MP_ACCESS_TOKEN_TEST --config wrangler.card-test.jsonc
npx wrangler secret put MP_WEBHOOK_SECRET_TEST --config wrangler.card-test.jsonc
```

- `FIREBASE_SERVICE_ACCOUNT`: JSON completo da conta de serviço do projeto de teste, não a conta de produção.
- `MP_ACCESS_TOKEN_TEST`: Access Token de teste da aplicação Mercado Pago.
- `MP_WEBHOOK_SECRET_TEST`: segredo de assinatura do webhook cadastrado para a URL deste Worker.

Nunca salvar esses valores no GitHub, HTML, arquivos de configuração ou mensagens.

## Antes de ligar o formulário

1. Fazer deploy isolado explicitamente com `npx wrangler deploy --config wrangler.card-test.jsonc`, somente depois de conferir os três secrets.
2. Copiar a URL confirmada do Worker `boca-delivery-card-test`.
3. No HTML da branch de desenvolvimento, apontar somente a chamada `/create-card-payment` para essa URL e configurar o webhook de teste no painel Mercado Pago.
4. Garantir que o Worker esteja usando o projeto Firebase `boca-delivery-teste`.
5. Testar crédito, débito e notificações com usuários/cartões de teste. Confirmar que somente o webhook de pagamento aprovado marca `pago=true`.

## Situação desta preparação

Os arquivos isolados podem ser preparados e revisados sem publicar Worker. Nenhum secret é criado automaticamente por estes arquivos; a configuração no painel/CLI e o deploy são etapas separadas e explícitas.
<!-- Atualização de documentação para disparar a compilação do Worker de teste. -->
