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
  (escala log) e posicionamento das seções: cada seção recebe um ponto **ilustrativo**,
  sorteado de forma determinística e uniforme dentro do polígono do município (Mersenne
  Twister bit-idêntico ao do CPython, seedeado pela identidade da seção — município IBGE +
  zona + seção; a mesma seção sempre cai no mesmo ponto, em qualquer candidato/cargo).
- `js/tse.js` — parser em stream do CSV oficial do TSE (`votacao_secao_<ANO>_<UF|BR>.csv`,
  latin-1, `;`): lista de candidatos por cargo e dataset por candidato (fallback do CDN).
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

O mapa tem duas camadas com significados geográficos **diferentes**:

1. **Choropleth por município (dado geográfico real)** — a cor de cada município é
   proporcional (escala log) aos votos totais do candidato **nesse município**. É a única
   camada com localização geográfica real, na granularidade que os dados oficiais suportam.
2. **Pontos (distribuição ilustrativa de seções)** — 1 ponto = 1 seção de votação com voto
   do candidato (raio ∝ votos na seção). O TSE **não publica coordenadas** das seções nem
   dos locais de votação; o arquivo oficial traz apenas o **nome** do local e o
   **endereço** em texto (exibidos no tooltip). Por isso a posição de cada ponto é
   *ilustrativa*: um sorteio determinístico e uniforme dentro do polígono do município
   (WGS84), seedeado pela identidade da seção (código IBGE do município + zona + seção).
   Consequências:
   - a mesma seção (município + zona + seção) aparece sempre no mesmo ponto, em qualquer
     candidato, cargo ou dataset, e em execuções repetidas;
   - o ponto **não** está no endereço real da seção — não interprete a posição dentro do
     município como localização do local de votação;
   - a *densidade* de pontos por município é real (1 seção = 1 ponto), mas a
     *distribuição espacial* dentro do município é uniforme.

Não há fonte pública oficial (TSE/IBGE) com coordenadas de seções/locais em lote, e o app
não inventa coordenadas nem usa centroides silenciosamente — por isso a diferenciação
explícita na UI (legenda, tooltip, rótulo do SVG e rodapé).

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
node test/tse_e2e.js      # zip oficial TSE -> parser JS vs dataset 1333 publicado (requer /tmp/tse_sc.zip)
```
