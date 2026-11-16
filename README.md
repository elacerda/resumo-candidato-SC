# Resumo Candidato — SC

App estático (sem backend) que gera um mapa interativo das seções de votação com voto
para um candidato em Santa Catarina. O usuário faz o upload de uma tabela JSON e o
mapa é desenhado **100% no navegador** — nenhum dado sai da máquina.

## Uso

- **Dados do TSE (2026)**: escolha cargo e turno, liste e filtre por nome ou número.
  A lista vem dos resultados oficiais EA20 publicados em `data/ea20/`; se essa fonte
  estiver indisponível, a lista histórica do snapshot de seções continua disponível.
  **Resultado agregado** mostra votos, classificação, situação, abrangência e atualização
  da fonte. Escolha um município e, opcionalmente, uma zona para consultar o TSE sob demanda.
  **Mostrar mapa** carrega somente o JSON do candidato e a tabela compartilhada de seções.
  Sem seções para o turno, apresenta o agregado disponível, sem fabricar marcadores.
  Nenhuma falha dispara download de ZIP. Os dados consultados ficam em memória durante
  a página; atualize a página para consultar uma nova versão publicada.
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
  latin-1, `;`), mantido apenas para diagnóstico offline no Node; não é carregado pelo site.
- `sync/geo_ref.py` — pipeline offline de georreferenciamento dos **locais de votação**
  (estado inteiro, 295 municípios): associa cada seção do snapshot 2026 ao seu local de
  votação por identificador oficial do TSE, obtém a coordenada WGS84 oficial
  ("Eleitorado por local de votação — 2026"), valida com PIP independente, preenche
  lacunas por OSM (instalações) e cruza com INEP (validação institucional) e TRE-SC
  (zona/endereço). Determinístico; publica `data/geo_loc/` + relatório em `reports/`.
- `sync/geo_pbf.py` — leitor de OSM PBF (protobuf) em stdlib, usado pelo pipeline.
- `js/ea20.js` — cliente e normalização de EA11/EA20, com validação de identidade,
  contadores e separação entre candidatos e partidos. Classificações jurídicas originais preservadas.
- `js/snapshots.js` — carregamento de um candidato, cache e verificação das somas/referências.
- `js/electoral.js` — serviço que mantém as fontes agregada e granular independentes.
- `js/source-compare.js` — comparação estrita de contextos eleitorais antes de comparar totais.
- `sync/ea20_sync.py` — captura oficial, valida identidade e publica espelhos estaduais pequenos.
- `sync/tse_sync.py` — processamento dos ZIPs exclusivamente offline/CI; valida ano,
  eleição, identidade dos votáveis e locais. Downloads com ETag/Last-Modified e hash do cache.
- `sync/snapshot_format.py` — publicação determinística de 667 arquivos individuais,
  partidos separados e metadados de origem; conserva arquivos legados para testes/diagnóstico.
- `.github/workflows/tse-sync.yml` — consulta, gera e valida; disponibiliza artefato
  para revisão, com `contents: read`. Não executa commit ou push.
- `js/app.js` — interface e mapa; upload JSON e exportações SVG/JSON preservados.
- `js/fflate.js` — [fflate](https://github.com/101arrowz/fflate) (MIT), usado somente
  no teste offline do ZIP oficial. Não integra o carregamento da página.

Detalhes do contrato, formato, decisões, limites e reprodução: [ARCHITECTURE.md](ARCHITECTURE.md).

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

A [configuração oficial EA11](https://resultados.tse.jus.br/oficial/comum/config/ele-c.json)
fornece eleições, cargos, turnos e abrangências. O [portal técnico oficial](https://www.tse.jus.br/eleicoes/informacoes-tecnicas-sobre-a-divulgacao-de-resultados)
documenta a nomenclatura dos EA20 estaduais, municipais e por zona.
Capturas reais e suas URLs/hashes/datas estão em `test/fixtures/ea20/`.

Os ZIPs oficiais `votacao_secao_2026_SC.zip` e `votacao_secao_2026_BR.zip`, do
[CDN de dados abertos](https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/),
são processados por `sync/tse_sync.py`. Não são baixados pelo navegador.
Brancos/nulos (`0,1,95,96,99` e nomes correspondentes) são excluídos. Legenda é
identificada por `SQ_CANDIDATO` e confirmada no cadastro partidário oficial, sem
heurística de comprimento do número. O snapshot mantém os votos nominais históricos,
inclusive quando uma candidatura não está no cadastro EA20 atual, com aviso explícito.

A UI informa a atualização da fonte usada. Totais EA20 e totais por seção não são
somados nem substituídos entre si; o CSV não informa o instante e estado de totalização
que permitiria afirmar equivalência temporal. Veja `reports/eleitoral_comparacao.json`.

## Testes

```
node test/app_smoke.js    # smoke do app com DOM shim (exemplo 1333)
node test/snapshot_app.js # app no modo snapshot: mapa individual, lista nominal e indisponibilidade sem ZIP
node test/geo_semantics.js# correção geográfica: join TSE→IBGE, referências de cidades, identidade/
                          # contenção/estabilidade dos pontos, agregados e semântica honesta na UI
node test/geo_verify.js   # catálogo georreferenciado: integridade, PIP independente,
                          # re-derivação do registro-fonte TSE/OSM, independência de
                          # candidato/cargo, frente (marcadores=locais, modos separados)
node test/tse_e2e.js      # zip oficial TSE -> parser JS vs dataset 1333 publicado (requer /tmp/tse_sc.zip)
node test/electoral_data.js # capturas EA20, turnos, categorias, fontes, CORS simulado, 667 snapshots
python3 test/snapshot_format_check.py # determinismo, origem das fixtures e cache HTTP simulado
node test/tse_panel_ux.js
node test/ui_browser.js --shot # servidor HTTP estático e Chrome, desktop/mobile, exportações e EA20
node test/labels_browser.js
python3 test/geo_pbf_roundtrip.py  # leitor PBF: roundtrip contra o proto oficial
python3 test/geo_ref_check.py      # catálogo publicado: schema, cobertura 295, contenção,
                                   # re-derivação TSE + spot-checks geográficos, rebuild determinístico
```

Teste de rede real, separado da suíte local: `python3 test/ea20_network.py`.
Para regenerar: execute primeiro `python3 sync/ea20_sync.py`, depois
`python3 sync/tse_sync.py`. Para reproduzir capturas sem rede:
`python3 sync/ea20_sync.py --fixtures test/fixtures/ea20 --out /tmp/ea20`.

A falha preexistente `geo_ref_check.py: rebuild == publicado` está registrada no
[relatório de implementação](reports/reestruturacao.md); o catálogo publicado foi preservado.

### Correções R02 e revisão dos dados

A listagem inclui os 12 históricos em grupo separado e informa a classificação dos
votos EA20 nas opções. Trocar cargo, turno ou território invalida consultas pendentes
e limpa exportações anteriores. Selecionar outro candidato atualiza o número consultado.

A geração padrão bloqueia promoção sem comprovação de equivalência entre versões.
Use `python3 sync/snapshot_format.py --review-only` apenas para gerar o diagnóstico;
`python3 sync/source_compare.py` retorna código 2 enquanto faltar revisão humana.
O fluxo de aprovação vinculada ao hash, os artefatos de revisão/promoção e os limites
da atualização diária estão em [ARCHITECTURE.md](ARCHITECTURE.md#r02-decisão-efetiva-de-promoção).
Regressões adicionais: `python3 test/source_compare_check.py` e
`python3 test/geo_rebuild_diagnostic.py` (somente diretório temporário; não altera catálogo).
A investigação geográfica detalhada está em [reports/reestruturacao-R02.md](reports/reestruturacao-R02.md).
