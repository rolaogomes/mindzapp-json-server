# Testes automatizados

Para validares os fluxos existentes no servidor JSON podes recorrer à suite de testes baseada em [Vitest](https://vitest.dev/).

## Preparação

1. Garante que tens as dependências instaladas:
   ```bash
   npm install
   ```
   > Se a instalação falhar devido a `ENOTEMPTY`, remove a pasta `node_modules` e volta a correr `npm install`.

## Execução

- Executar toda a suite uma única vez:
  ```bash
  npm run test:run
  ```
- Correr em modo watch durante o desenvolvimento:
  ```bash
  npm run test:watch
  ```
- Gerar relatório de cobertura:
  ```bash
  npm run test:coverage
  ```

Estes scripts chamam diretamente o binário local do Vitest (`node node_modules/vitest/vitest.mjs`), evitando problemas com permissões do wrapper gerado em `node_modules/.bin/vitest` em ambientes onde o bit de execução é removido.