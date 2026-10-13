# Resumo Candidato — SC

App estático (sem backend) que gera um mapa interativo das seções de votação com voto
para um candidato em Santa Catarina. O usuário faz o upload de uma tabela JSON e o
mapa é desenhado **100% no navegador** — nenhum dado sai da máquina.

## Uso

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
- `js/app.js` — upload/drag&drop, validação, render SVG, HUD, tooltip, zoom/pan e exportações.
- `data/geo_sc_municipios.json` — malha municipal de SC (IBGE, espelho tbrugz/geodata-br).
- `data/1333_sc_2026.json` — dataset de exemplo (extração TSE).

## Testes

```
node test/e2e.js       # pipeline JS vs mapa Python publicado (3397 pontos idênticos)
node test/app_smoke.js # smoke do app com DOM shim
```
