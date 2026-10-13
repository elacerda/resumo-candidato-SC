# AGENTS.md — resumo-candidato-SC

App **estático, sem backend** (GitHub Pages: `elacerda.github.io/resumo-candidato-SC/`), em
100% JavaScript no navegador: mapa interativo das seções de votação **com voto** de um
candidato em Santa Catarina, Eleições 2026. Cada ponto = 1 seção; choropleth por município.
Nenhum dado sai da máquina do usuário.

## Como o usuário usa (3 modos)

1. **Upload JSON** — tabela `{total, mun, sections}` (formato em `README.md`).
2. **Dados do TSE (snapshot, padrão)** — consulta a `data/tse_2026/` na mesma origem do
   Pages: lista candidatos por cargo e monta o mapa **por número, sem download**.
3. **Dados do TSE (CDN, fallback)** — quando não há snapshot ou o número está fora dele,
   baixa `votacao_secao_2026_SC.zip` (74,5 MB) / `_BR.zip` (154 MB, só Presidente) de
   `cdn.tse.jus.br`, unzip no navegador (fflate) e parseia o CSV em stream. Fica em cache
   (IndexedDB + memória).

## Estrutura

```
index.html / style.css        UI (painel TSE, dropzone, mapa SVG, HUD)
js/core.js                    Geometria + posicionamento determinístico (porta 1:1 do Python)
js/tse.js                     Parser stream do CSV oficial do TSE (funções puras, testável no Node)
js/app.js                     App: modos, snapshot, fallback CDN, render SVG, zoom/pan, export
js/fflate.js                  fflate (MIT) — usar unzipSync
data/geo_sc_municipios.json   Malha municipal de SC (IBGE, espelho tbrugz/geodata-br)
data/1333_sc_2026.json        Exemplo (J. Andózio, 1333, Dep. Federal, 2026)
data/tse_2026/                Snapshot TSE (gerado por sync/tse_sync.py)
sync/tse_sync.py              Gera o snapshot (stdlib only, determinístico)
.github/workflows/tse-sync.yml  CI: re-gera snapshot (diário + manual + push no script)
test/                         Testes Node (DOM shim; ver abaixo)
```

### Formato do snapshot (`data/tse_2026/`)

- `index.json`: `{eleicao, uf, gerado_em, secoes: "secoes.json", cargos: {
  "DEPUTADO FEDERAL": {arquivo, candidatos: {numero: [nome, total, nSecoes, nMunicipios]}}}}`
- `secoes.json`: `{mun: [[codeTSE, nome], ...], secoes: [[munIdx, zona, secao, local, end], ...]}`
  (dedup por município+zona+seção; SC = 17.326 seções, 295 municípios)
- `<cargo>.json`: `{cargo, cand: {numero: [[idxSecao, votos], ...]}}`
- Cargos: DEPUTADO FEDERAL, DEPUTADO ESTADUAL, GOVERNADOR, SENADOR (zip SC) e
  PRESIDENTE (zip BR, **filtrado para UF=SC**). 1º turno apenas.
- `gerado_em` = `DT_GERACAO/HH_GERACAO` do arquivo TSE → **determinístico**; o CI só
  commita quando o TSE atualiza os dados.

### Formato do dataset do app

`{total, mun: {codeTSE: {nome, votos, secoes}}, sections: [{muni, muni_nome, zona, secao,
votos, local, end}], candidato?, numero?, cargo?, eleicao?, fonte?}`.

## Invariantes críticas (não quebrar)

1. **MT19937 bit-idêntico ao CPython** (`core.js`): o ponto de cada seção dentro do
   município vem de rejeição determinística seedeada pelo ID IBGE do município.
   - 2º loop de `init_by_array`: multiplicador **1566083941**.
   - `random()` (res53): `(a * 67108864 + b) * (1/9007199254740992)`.
   - Mudança aqui muda TODOS os pontos do mapa → roda `node test/e2e.js`.
2. **Ordem das seções define o mapa**: a ordem dentro de cada município = ordem do arquivo
   CSV do TSE. O exemplo `data/1333_sc_2026.json` e o snapshot seguem essa ordem; se o TSE
   republishar o arquivo em outra ordem, regere o exemplo (mesma lógica de `sync/tse_sync.py`)
   para manter exemplo/CDN/snapshot idênticos.
3. **CSV do TSE**: latin-1, separador `;`, 26 colunas, campos de texto entre aspas,
   registros de linha única. Colunas usadas: `SG_UF`, `NR_TURNO`, `DS_CARGO`, `NR_VOTAVEL`,
   `NM_VOTAVEL`, `CD_MUNICIPIO`, `NM_MUNICIPIO`, `NR_ZONA`, `NR_SECAO`, `QT_VOTOS`,
   `NM_LOCAL_VOTACAO`, `DS_LOCAL_VOTACAO_ENDERECO`.
4. **Branco/nulo excluídos** das listas/datasets: números `0, 1, 95, 96, 99` **e** nomes
   com `VOTO BRANCO`/`VOTO NULO` (regex) — espelhar `tse.js` em qualquer sync novo.
5. **Chaves inteiras em objeto JS iteram em ordem numérica ascendente** (não a ordem de
   inserção) — por isso `tseList()` ordena a lista por votos explicitamente.
6. **fflate**: usar `unzipSync`; no navegador, dar um `setTimeout` antes do unzip para o
   status de progresso pintar (ver `getTseCsv`).
7. **Mapeamento TSE→IBGE** de municípios: `Core.mapTseToGeo` (código/nome → feature da
   malha). Não inventar outro caminho.
8. Snapshot: **só SC** em todos os cargos (inclusive Presidente).

## Testes (Node, sem dependências)

```
node test/app_smoke.js     # app com DOM shim: exemplo 1333 (3397 dots), validação de erro
node test/snapshot_app.js  # modo snapshot: mapa/lista por número + fallback CDN com "Failed to fetch"
node test/e2e.js           # pipeline JS vs mapa Python publicado (3397 pontos idênticos)
node test/tse_e2e.js       # zip oficial TSE -> parser JS vs dataset publicado (requer /tmp/tse_sc.zip)
```

Após mexer em `js/`, `data/` ou `sync/`: rode **todos** os quatro (os dois últimos precisam
de zips TSE em `/tmp`: `votacao_secao_2026_SC.zip` / `tse_sc.zip`). O `e2e.js` lê do próprio
repo (`data/` + `1333_sc_mapa.html` de referência).

## Regenerando o snapshot

```
python3 sync/tse_sync.py --out data/tse_2026 \
  [--zip-sc /caminho/votacao_secao_2026_SC.zip] [--zip-br ...]   # senão baixa do CDN
```

Validação canônica (1333 = `JULIANA ANDOZIO`, 4876 votos, 3397 seções, 224 municípios;
conjunto + ordem por município + local/end idênticos ao `data/1333_sc_2026.json`).
Commit do snapshot: só quando o conteúdo muda (o CI compara com `git diff --cached`).

## CI / deploy

- Push em `main` → GitHub Pages deploy (~1 min).
- `tse-sync.yml`: dispara em `workflow_dispatch`, cron diário 06:00 UTC e `push` em
  `sync/tse_sync.py`/`tse-sync.yml`; baixa os zips, regenera `data/tse_2026/`, commita com
  `GITHUB_TOKEN` (permissão `contents: write`) apenas se houve mudança.
- Não commitar zips/CSVs; `data/tse_2026/` (~20 MB) é o artefato.

## Convenções

- pt-BR em UI, erros, commits e README.
- Erros de rede do TSE no app devem usar `tseError()`/`describeTseError()` (mensagem clara +
  botão "Tentar novamente"), nunca `tseStatus('Falha: ' + e.message)` cru.
- Sem dependências npm (o app é arquivo solto + fflate embutido); não introduzir bundler.
