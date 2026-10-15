# Resumo Candidato — SC

App estático (sem backend) que gera um mapa interativo das seções de votação com voto
para um candidato em Santa Catarina. O usuário faz o upload de uma tabela JSON e o
mapa é desenhado **100% no navegador** — nenhum dado sai da máquina.

## Uso

- **Dados do TSE (2026)**: para os cargos **Deputado Federal, Deputado Estadual,
  Governador, Senador** (arquivo estadual do TSE) e **Presidente** (arquivo nacional,
  filtrado para SC). Primeiro o app consulta o **snapshot** (`data/tse_2026/`), pré-computado
  neste repositório pelo GitHub Actions a partir dos arquivos oficiais: lista e mapa por
  número carregam na hora, **sem download**. Sem snapshot (ou para número fora dele), o app
  baixa o arquivo direto do CDN do TSE (`cdn.tse.jus.br`, CORS aberto) — uma única vez, com
  progresso, e fica em cache (IndexedDB) no dispositivo. Nada é enviado a nenhum servidor.
- **Carregar JSON** (ou arrastar o arquivo para a página): tabela no formato abaixo.
- **Exemplo (1333)**: carrega o dataset de exemplo (Ju Andózio, 1333, SC, 2026).
- **Baixar SVG / JSON**: exporta o mapa estático (com tooltips nativos) ou o dataset.

Interação do mapa: scroll = zoom (centrado no cursor) · arrastar = mover · duplo clique = resetar.

## Formato do JSON

```json
{
  "total": 4876,
  "candidato": "Profª Ju Andózio",
  "numero": "1333",
  "cargo": "Deputada Federal",
  "eleicao": "Eleições 2026 · 1º turno (04/10)",
  "mun": {
    "81051": { "nome": "FLORIANÓPOLIS", "votos": 1745, "secoes": 789 }
  },
  "sections": [
    { "muni": "81051", "muni_nome": "FLORIANÓPOLIS", "zona": "100", "secao": "313",
      "votos": 1, "local": "E.E.M. JACÓ ANDERLE", "end": "RUA FRANCISCO FAUSTO MARTINS, S/N" }
  ]
}
```

- `mun`: código TSE do município → `{nome, votos, secoes}`.
- `sections`: uma entrada por seção com voto (`muni`, `zona`, `secao`, `votos`, `local`, `end`).
- `candidato`, `numero`, `cargo`, `eleicao`, `estado`: opcionais (título/legenda do mapa).

## Como funciona

- `js/core.js` — núcleo de geometria: projeção equiretangular, choropleth por município
  (escala log) e posicionamento determinístico de seções em **modo ilustrativo**
  (fallback sem catálogo de coordenadas): ponto sorteado uniformemente dentro do
  polígono do município, Mersenne Twister bit-idêntico ao do CPython, seedeado pela
  identidade da seção (município IBGE + zona + seção) — a mesma seção sempre cai no
  mesmo ponto. Com o catálogo `data/geo_loc`, os marcadores usam as coordenadas
  verificadas dos locais de votação (ver "Semântica geográfica do mapa").
- `js/tse.js` — parser em stream do CSV oficial do TSE (`votacao_secao_<ANO>_<UF|BR>.csv`,
  latin-1, `;`): lista de candidatos por cargo e dataset por candidato (fallback do CDN).
- `sync/geo_ref.py` — pipeline offline de georreferenciamento dos **locais de votação**
  (estado inteiro, 295 municípios): associa cada seção do snapshot 2026 ao seu local de
  votação por identificador oficial do TSE, obtém a coordenada WGS84 oficial
  ("Eleitorado por local de votação — 2026"), valida com PIP independente, preenche
  lacunas por OSM (instalações) e cruza com INEP (validação institucional) e TRE-SC
  (zona/endereço). Determinístico; publica `data/geo_loc/` + relatório em `reports/`.
- `sync/geo_pbf.py` — leitor de OSM PBF (protobuf) em stdlib, usado pelo pipeline.
- `sync/tse_sync.py` — gera o snapshot (`data/tse_2026/`): baixa os zips oficiais do TSE,
  filtra SC/1º turno e escreve `index.json` (candidatos por cargo com totais), `secoes.json`
  (tabela única de seções + municípios) e um arquivo por cargo com os votos por seção.
  Determinístico (timestamp = `DT_GERACAO` do arquivo TSE).
- `.github/workflows/tse-sync.yml` — re-gera o snapshot diariamente (e sob demanda) e
  commita somente quando o TSE atualizar os dados.
- `js/app.js` — modo TSE (download com progresso + cache IndexedDB + unzip via `fflate`),
  upload/drag&drop, validação, render SVG, HUD, tooltip, zoom/pan e exportações.
- `js/fflate.js` — [fflate](https://github.com/101arrowz/fflate) (MIT), descompactação zip no navegador.
- `data/geo_sc_municipios.json` — malha municipal de SC (IBGE, espelho tbrugz/geodata-br).
- `data/1333_sc_2026.json` — dataset de exemplo (extração TSE).

## Semântica geográfica do mapa

O mapa tem camadas com significados geográficos **diferentes**, e a UI diferencia cada
uma explicitamente (aria do SVG, HUD, legenda, tooltips e avisos):

1. **Choropleth por município (dado geográfico real)** — a cor de cada município é
   proporcional (escala log) aos votos totais do candidato **nesse município**.
2. **Marcadores nos locais de votação (coordenada verificada)** — com o catálogo
   `data/geo_loc/` (gerado por `sync/geo_ref.py`), cada **local de votação** com
   coordenada verificada recebe **um único marcador** na coordenada oficial do TSE
   (dataset "Eleitorado por local de votação — 2026", WGS84). Seções que compartilham
   o mesmo local compartilham a mesma posição e aparecem agregadas no marcador
   (tooltip lista as seções e os votos por seção). O raio do marcador é proporcional
   aos votos agregados do local para o candidato. As coordenadas pertencem ao local,
   nunca ao candidato: a mesma seção fica no mesmo ponto em qualquer candidato/cargo.
   A validação independe do pipeline que gerou o catálogo (PIP próprio, re-derivação
   do arquivo-fonte TSE no `test/geo_verify.js`).
3. **Seções sem coordenada verificada** — não são plotadas por padrão (os totais e o
   choropleth preservam essas seções; a UI informa quantas ficaram de fora). O botão
   "Sem coordenada: modo ilustrativo" as desenha como **círculos ocos tracejados** em
   posição determinística dentro do polígono do município — visualmente distinto do
   marcador verificado e explicitamente rotulado; as coordenadas verificadas nunca são
   alteradas por esse modo.
4. **Fallback sem catálogo (estado indisponível declarado)** — se `data/geo_loc/`
   estiver indisponível (ex.: build parcial), **nenhum ponto sintético é desenhado por
   padrão**: o mapa exibe apenas choropleth, rótulos e totais por município (preservados),
   e a UI declara em todos os lugares (aria do SVG, HUD, legenda e aviso) que o
   georreferenciamento está indisponível. O botão "Modo ilustrativo (sem catálogo)"
   desenha, **somente por escolha explícita do usuário**, 1 ponto **ilustrativo** por
   seção (Mersenne Twister determinístico dentro do polígono do município) como círculos
   ocos tracejados, com a UI declarando o modo ILUSTRATIVO em todos os lugares. Os dois
   modos **nunca se misturam** no mesmo mapa.

Regras do catálogo (proveniência — `reports/geo_cobertura.json` detalha):

- fonte primária: coordenadas oficiais do TSE (autoritativas); OSM (extrato geofabrik)
  apenas para lacunas sem coordenada oficial (ex.: penitenciárias), com referência da
  feature no catálogo;
- INEP (Censo Escolar 2025/2024) e TRE-SC são **validação** (existência da unidade,
  rua, zona, CEP) — nenhum dos dois fornece coordenada neste fluxo (o Censo Escolar
  não publica georreferência desde 2023);
- centroides de município/bairro/CEP nunca são promovidos a coordenada de local;
  coordenada fora do polígono do município → flag (até 500 m: "edge"; além: não
  publicada, reportada para revisão) — nada é realocado automaticamente;
- nenhum ponto apresentado como real sem proveniência rastreável (arquivo-fonte,
  identificador, método de match e status em cada linha do catálogo).

## Georreferenciamento (como regerar o catálogo)

```
python3 sync/geo_ref.py           # usa cache/ já populada (offline)
python3 sync/geo_ref.py --fetch   # (re)baixa fontes ausentes (TSE/INEP/OSM/TRE-SC)
```

Fontes (todas oficiais; URLs e hashes no `reports/geo_cobertura.json`):

- TSE "Eleitorado por local de votação — 2026" (`eleitorado_local_votacao_2026.zip`,
  CSV por UF) — associação seção→local + coordenadas oficiais;
- snapshot do repositório `data/tse_2026/` — seções do app (17.326 em SC);
- INEP Censo Escolar 2025 (+2024 para endereços) — validação institucional;
- OSM geofabrik `sul-latest.osm.pbf` (extrato RS+SC+PR) — lacunas + verificação
  independente; processado 100% offline por `sync/geo_pbf.py`;
- TRE-SC (API `lista-locais`) — cross-check de zona/endereço/CEP.

Saídas: `data/geo_loc/{index,locais,secoes,pendentes}.json` (catálogo publicado,
determinístico para as mesmas entradas) e `reports/geo_cobertura.json` (cobertura por
município, status, validações e proveniência). `cache/` (downloads, ~700 MB) **não** é
commitada; `data/geo_loc/` (~1,8 MB) sim.

## Fonte dos dados do TSE



`https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2026_<UF|BR>.zip`
(CSV latin-1, separador `;`; colunas: UF, município, zona, seção, cargo, votável,
QT_VOTOS, local de votação e endereço). O servidor responde
`Access-Control-Allow-Origin: *`, por isso a consulta é feita direto do navegador,
sem backend. Branco/nulo (números 0/1/95/96/99 e "VOTO BRANCO/NULO") são excluídos
das listas de candidatos.

O TSE não expõe API de consulta por candidato na granularidade de seção — o zip por
seção é a única fonte oficial. Por isso o snapshot: o sync baixa e compacta os dados
no servidor de CI e commita em `data/tse_2026/` (~20 MB para os 5 cargos de SC),
permitindo consulta instantânea por número no próprio GitHub Pages.

## Testes

```
node test/app_smoke.js    # smoke do app com DOM shim (exemplo 1333)
node test/snapshot_app.js # app no modo snapshot: mapa/lista por número + fallback CDN com falha de rede
node test/geo_semantics.js# correção geográfica: join TSE→IBGE, referências de cidades, identidade/
                          # contenção/estabilidade dos pontos, agregados e semântica honesta na UI
node test/geo_verify.js   # catálogo georreferenciado: integridade, PIP independente,
                          # re-derivação do registro-fonte TSE/OSM, independência de
                          # candidato/cargo, frente (marcadores=locais, modos separados)
node test/tse_e2e.js      # zip oficial TSE -> parser JS vs dataset 1333 publicado (requer /tmp/tse_sc.zip)
python3 test/geo_pbf_roundtrip.py  # leitor PBF: roundtrip contra o proto oficial
python3 test/geo_ref_check.py      # catálogo publicado: schema, cobertura 295, contenção,
                                   # re-derivação TSE + spot-checks geográficos, rebuild determinístico
```
