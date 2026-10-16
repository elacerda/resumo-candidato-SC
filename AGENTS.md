# AGENTS.md — resumo-candidato-SC

App **estático, sem backend** (GitHub Pages: `elacerda.github.io/resumo-candidato-SC/`), em
100% JavaScript no navegador: mapa interativo das seções de votação **com voto** de um
candidato em Santa Catarina, Eleições 2026. Cada marcador = 1 local de votação em coordenada
verificada (catálogo `data/geo_loc/`; 99,97% das seções cobertas; as seções do local são agregadas
no marcador); choropleth por município. Sem o catálogo, o app declara georreferenciamento
indisponível e o modo ilustrativo só é exibido por escolha explícita.
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
data/geo_loc/                 Catálogo de georreferenciamento (locais + coords verificadas)
sync/geo_ref.py               Pipeline offline de georreferenciamento (stdlib; determinístico)
sync/geo_pbf.py               Leitor OSM PBF (stdlib) para o pipeline
sync/geo_overrides.json       Revisões geográficas manuais auditáveis (manifesto; aplicado pelo pipeline)
data/1333_sc_2026.json        Exemplo (J. Andózio, 1333, Dep. Federal, 2026)
data/tse_2026/                Snapshot TSE (gerado por sync/tse_sync.py)
sync/tse_sync.py              Gera o snapshot (stdlib only, determinístico)
.github/workflows/tse-sync.yml  CI: re-gera snapshot (diário + manual + push no script)
.github/workflows/geo-sync.yml  CI: re-gera catálogo data/geo_loc (diário + manual + push no pipeline)
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

1. **MT19937 bit-idêntico ao CPython** (`core.js`): usado apenas no **modo
   ilustrativo** (fallback sem catálogo ou overlay "sem coordenada"), a posição de cada
   seção é um sorteio determinístico e **uniforme** dentro da união dos anéis do
   município, **seed = `sectionSeed(muni IBGE, zona, seção)`** (FNV-1a little-endian +
   finalizer Murmur3-32). A IDENTIDADE da seção define o ponto — a mesma seção
   (município + zona + seção) aparece SEMPRE no mesmo ponto, em qualquer
   candidato/cargo/dataset.
   - 2º loop de `init_by_array`: multiplicador **1566083941**.
   - `random()` (res53): `(a * 67108864 + b) * (1/9007199254740992)`.
   - Posições MT19937 são **ILUSTRATIVAS**: nunca podem ser apresentadas como
     localização real. Com catálogo `data/geo_loc`, os marcadores usam as coordenadas
     verificadas dos LOCAIS de votação (invariante 10); o modo ilustrativo deve ficar
     visual e textualmente separado (círculos ocos tracejados + rótulo "ilustrativo").
   - Mudança aqui muda TODOS os pontos ilustrativos → rode `node test/geo_semantics.js`
     (inclui valores de referência gerados com CPython).
2. **A posição do ponto NÃO depende da ordem do CSV**: é função da identidade da seção
   (muni IBGE + zona + seção). A ordem das seções no dataset continua = ordem do arquivo
   CSV do TSE (fiel aos dados); o exemplo `data/1333_sc_2026.json` e o snapshot a seguem —
   se o TSE republishar em outra ordem, regere o exemplo (mesma lógica de `sync/tse_sync.py`),
   mas o mapa é invariante à ordem.
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
9. **Semântica geográfica honesta**: o choropleth (votos por município) é o dado
   geográfico real. Com o catálogo `data/geo_loc`, os marcadores representam LOCAIS de
   votação em coordenada **verificada** (oficial TSE; OSM só em lacunas). Sem catálogo,
   o mapa é **ilustrativo** e a UI deve declará-lo. Nunca apresentar posição MT19937
   como localização real, nem promover centroides de município/bairro/CEP a coordenada
   de local — validado por `test/geo_semantics.js` e `test/geo_verify.js`.
10. **Georreferenciamento (catálogo `data/geo_loc/`)**: a posição de uma seção é a
    posição VERIFICADA do seu local de votação, nunca um ponto gerado dentro do
    município.
    - Fonte primária: TSE "Eleitorado por local de votação — 2026"
      (`eleitorado_local_votacao_2026.zip`, CSV/UF, decimal com vírgula, sentinela
      `-1,-1` = sem coordenada) — associação seção→local e coordenada oficiais.
    - Identidade do local físico = **(código TSE do município, zona,
      NR_LOCAL_VOTACAO)**; múltiplas seções podem compartilhar o local (e a
      coordenada). O código do local NÃO é único globalmente — nunca usá-lo sem
      (município, zona).
    - Coordenadas pertencem ao LOCAL, nunca a candidato/cargo/dataset.
    - OSM (extrato geofabrik `sul-latest.osm.pbf`) preenche lacunas sem coordenada
      oficial (match de nome com unicidade no top tier) e verifica independentemente
      (<=150 m confirma; >500 m conflito — flag, NUNCA realoca). INEP = validação
      institucional apenas (sem coordenada desde 2023). TRE-SC = cross-check de
      zona/endereço/CEP.
    - Fora do polígono do município: <=500 m → status `edge` (publicado, com flag);
      além → **não publicado**, reportado em `pendentes.json` para revisão.
    - `cache/` (downloads) NÃO é commitado; `data/geo_loc/` e
      `reports/geo_cobertura.json` sim (commitado pelo CI `geo-sync.yml`).
    - Regerar: `python3 sync/geo_ref.py` (offline com cache; `--fetch` para baixar).
      Determinístico: mesmas entradas (fontes + manifesto de revisões) → bytes
      idênticos (validado por `test/geo_ref_check.py` §9).
    - **Revisões manuais auditáveis** (`sync/geo_overrides.json`): única forma de
      alterar uma coordenada por decisão humana — manifesto versionado, com
      veredito `corrigir` (coord nova + evidências com fonte/URL/data) ou
      `documentar` (parecer sem mudar coordenada). O pipeline valida o manifesto
      em falha-dura, aplica e RE-VALIDA (PIP/bbox) as coords revisadas; o sha256
      do manifesto entra em `fontes['revisoes_manuais']` → `_gerado_em` (proteção
      contra catálogo defasado). A coordenada original TSE fica preservada em
      `obs`. Testado por `test/geo_ref_check.py` §8 e `test/geo_verify.js` §8.
    - O app consome o catálogo sem fazer geocoding em runtime (fetch estático de
      `data/geo_loc/`); sem catálogo, o app entra em estado declarado de
      georreferenciamento **indisponível** (sem pontos sintéticos por padrão; totais e
      choropleth preservados) e o modo ilustrativo só é exibido por escolha explícita
      (botão "Modo ilustrativo (sem catálogo)").

## Testes (Node, sem dependências)

```
node test/app_smoke.js     # app com DOM shim: exemplo 1333 (3397 dots), validação de erro
node test/snapshot_app.js  # modo snapshot: mapa/lista por número + fallback CDN com "Failed to fetch"
node test/tse_panel_ux.js  # painel TSE (UX): parágrafo intro simplificado, #tseFilterRow/#tseSel
                           # ocultos no início, visíveis só após lista bem-sucedida, reset na
                           # troca de cargo, falha mantém oculto, "Mostrar mapa" direto preservado
node test/geo_semantics.js # correção geográfica: join TSE→IBGE (295/295), referências de cidades
                           # (Wikipedia), identidade/contenção/estabilidade dos pontos, agregados,
                           # semântica honesta na UI (DOM shim)
node test/geo_verify.js    # catálogo georreferenciado: integridade, PIP próprio, plausibilidade
                           # por cidade, re-derivação do registro-fonte (TSE/OSM no cache),
                           # independência de candidato/cargo, front (marcadores=locais,
                           # modo ilustrativo separado, fallback sem catálogo: estado
                           # indisponível + ilustrativo por escolha explícita)
node test/tse_e2e.js       # zip oficial TSE -> parser JS vs dataset publicado (requer /tmp/tse_sc.zip)
python3 test/geo_pbf_roundtrip.py # leitor PBF (roundtrip contra o proto oficial)
python3 test/geo_ref_check.py     # catálogo publicado: schema 16 colunas, 295 municípios,
                                  # contenção PIP, re-derivação TSE + spot-checks geográficos,
                                  # prisões, rebuild determinístico offline
```

Após mexer em `js/`, `data/` ou `sync/`: rode **todos** (o `tse_e2e.js` precisa do zip TSE
em `/tmp`: `tse_sc.zip`; o `geo_ref_check.py` e o `geo_verify.js` precisam de `cache/`
populada com o CSV TSE de locais e o JSON OSM — ver `sync/geo_ref.py --fetch`).

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
