# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Usuário principal (inferido, não confirmado):** operadores políticos — equipes de campanha/estratégia e analistas eleitorais — que, durante as Eleições 2026, precisam ver **onde** um candidato teve voto em SC, seção a seção, para planejar atuação (ex.: priorizar municípios/seções, porta a porta).
- Situação: no navegador, em qualquer dispositivo, durante campanha/apuração; o app carrega dados oficiais sem enviar nada a nenhum servidor.
- Público secundário plausível: jornalistas e pesquisadores que exportam o mapa (SVG) ou o dataset (JSON) para outros usos.

## Product Purpose

Mapa interativo das seções de votação **com voto** de um candidato em Santa Catarina (Eleições 2026, 1º turno): cada ponto = 1 seção, com choropleth por município. Sucesso: dado o número do candidato, a pessoa vê instantaneamente a distribuição de voto seção a seção, 100% local, a partir de dados oficiais do TSE.

## Positioning

Dados oficiais do TSE na granularidade de seção (o TSE não expõe API por candidato nessa granularidade — o zip de votação por seção é a única fonte oficial) **e** privacidade absoluta: sem backend, sem upload, nenhum dado sai da máquina do usuário. O snapshot pré-computado no próprio repositório (GitHub Pages) entrega consulta por número sem nenhum download; o CDN do TSE é o fallback.

## Operating Context

- Hospedagem: GitHub Pages (`elacerda.github.io/resumo-candidato-SC/`), app 100% estático.
- Snapshot `data/tse_2026/` (~20 MB) gerado por `sync/tse_sync.py` (stdlib only, determinístico) e re-gerado por GitHub Actions (diário 06:00 UTC, manual e push no script), com commit somente quando o TSE atualiza os dados.
- Fallback CDN: `cdn.tse.jus.br` (CORS aberto), zip baixado uma única vez, unzip via fflate no navegador, cache em IndexedDB + memória.
- Exportação: SVG estático do mapa (com tooltips nativos) e dataset JSON.
- Interação do mapa: scroll = zoom, arrastar = mover, duplo clique = resetar.
- Testes: Node sem dependências (`node test/app_smoke.js`, `node test/snapshot_app.js`, `node test/tse_e2e.js` — este último requer `/tmp/tse_sc.zip`).

## Capabilities and Constraints

**Capacidades**
- 3 modos: (1) upload/drag&drop de JSON do usuário; (2) snapshot TSE (padrão) — lista de candidatos por cargo e mapa por número; (3) fallback CDN do TSE com progresso.
- Cargos: Deputado Federal, Deputado Estadual, Governador, Senador (zip SC) e Presidente (zip BR, filtrado para UF=SC). Só 1º turno.

**Invariantes (técnicas, não quebrar)**
- Posicionamento dos pontos: MT19937 **bit-idêntico ao CPython** (rejeição determinística seedeada pelo ID IBGE do município) — a mesma seção sempre cai no mesmo ponto.
- Ordem das seções dentro de cada município = ordem do CSV oficial do TSE; exemplo, snapshot e CDN devem ser idênticos.
- Branco/nulo excluídos: números `0, 1, 95, 96, 99` e nomes `VOTO BRANCO/NULO` (regex).
- CSV do TSE: latin-1, separador `;`, 26 colunas, registros de linha única.
- Mapeamento TSE→IBGE só por `Core.mapTseToGeo`.

**Constraints de produto/stack**
- Sem backend, sem dependências npm, sem bundler (arquivos soltos + fflate embutido).
- UI, erros, commits e README em pt-BR.
- Erros de rede do TSE usam `tseError()`/`describeTseError()` (mensagem clara + botão "Tentar novamente").
- Snapshot: **só SC** em todos os cargos.

**Decisões em aberto**
- Perfil do usuário principal (ver `## Users`) — não confirmado pelo dono.
- Se há plano de expansão para outros anos/UFs — não confirmado.

## Brand Commitments

- Nome: **Resumo Candidato — SC**.
- **Cor de destaque: vermelho.** O usuário declarou odiar azul neste projeto (auto-descreve-se como "kinda communist") — azul é vetado como cor de destaque; retema azul→vermelho aplicado em 2026-10-13 (`--accent #f63b4b`, `--line2 #7a353b`, claro `#fd939c`; pontos das seções permanecem laranja `#ffb454`).
- Voz: pt-BR, direta, tom de ferramenta (não de marketing).

## Evidence on Hand

- `data/1333_sc_2026.json` — dataset de exemplo canônico (Jú Andózio, 1333, Dep. Federal 2026: 4.876 votos, 3.397 seções, 224 municípios).
- `data/tse_2026/` — snapshot oficial do TSE (5 cargos, SC), gerado por CI a partir dos zips oficiais.
- `data/geo_sc_municipios.json` — malha municipal de SC (IBGE, espelho tbrugz/geodata-br).
- `test/` — suíte Node (smoke, snapshot, e2e zip oficial vs dataset publicado).
- **Ausências a não inventar:** sem depoimentos, clientes, métricas de uso, preços ou claims de deploy além do GitHub Pages.

## Product Principles

1. **O dado não sai da máquina** — sem backend, sem upload; a consulta oficial é feita direto do navegador (CDN com CORS) ou no snapshot do próprio repositório.
2. **TSE é a única verdade** — dados oficiais exclusivamente; branco/nulo sempre excluído; sem fontes de terceiros.
3. **Determinismo** — mesma seção, mesmo ponto, sempre (MT19937 ≡ CPython); mesma ordem do CSV; exemplo/snapshot/CDN idênticos.
4. **Zero dependência** — arquivos estáticos + fflate embutido; nada de npm/bundler.
5. **Vermelho, nunca azul** — identidade visual comprometida com vermelho como cor de destaque.
