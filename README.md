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

- `js/core.js` — porta 1:1 do gerador Python (`gen_mapa_1333.py`): projeção
  equiretangular, encaixe de pontos dentro dos polígonos por grade determinística com
  rejeição (Mersenne Twister idêntico ao do Python — a mesma seção sempre cai no mesmo
  ponto) e choropleth por município (escala log).
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
node test/e2e.js       # pipeline JS vs mapa Python publicado (3397 pontos idênticos)
node test/app_smoke.js # smoke do app com DOM shim
node test/tse_e2e.js     # zip oficial TSE -> parser JS vs dataset 1333 publicado (requer /tmp/tse_sc.zip)
node test/snapshot_app.js # app no modo snapshot: mapa/lista por número + fallback CDN com falha de rede
```
