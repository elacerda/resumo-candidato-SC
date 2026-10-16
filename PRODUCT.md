# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Público-alvo não confirmado pelo dono.** Não assumir um usuário principal; tratar os usos abaixo como plausíveis, não verificados.
- Usos plausíveis (não verificados): acompanhar **onde** um candidato teve voto em SC, seção a seção, durante campanha/apuração; análise eleitoral (distribuição por município, local de votação, totais); exportação do mapa (SVG) ou do dataset (JSON) para outros usos.
- Situação: no navegador, em qualquer dispositivo; o app carrega dados oficiais sem enviar nada a nenhum servidor.

## Product Purpose

Mapa interativo das seções de votação **com voto** de um candidato em Santa Catarina (Eleições 2026, 1º turno): cada marcador = 1 local de votação em coordenada verificada (as seções do local são agregadas no marcador; cobertura de 99,97% das seções), com choropleth por município. Sucesso: dado o número do candidato, a pessoa vê instantaneamente a distribuição de voto seção a seção, 100% local, a partir de dados oficiais do TSE.

## Positioning

Dados oficiais do TSE na granularidade de seção (o TSE não expõe API por candidato nessa granularidade — o zip de votação por seção é a única fonte oficial) **e** privacidade absoluta: sem backend, sem upload, nenhum dado sai da máquina do usuário. O snapshot pré-computado no próprio repositório (GitHub Pages) entrega consulta por número sem nenhum download; o CDN do TSE é o fallback. O catálogo `data/geo_loc/` (coordenadas verificadas dos locais de votação, gerado por pipeline offline e re-gerado por CI) fornece a posição real dos marcadores; sem ele, o app declara georreferenciamento indisponível e oferece o modo ilustrativo apenas por escolha explícita.

## Operating Context

- Hospedagem: GitHub Pages (`elacerda.github.io/resumo-candidato-SC/`), app 100% estático.
- Snapshot `data/tse_2026/` (~20 MB) gerado por `sync/tse_sync.py` (stdlib only, determinístico) e re-gerado por GitHub Actions (diário 06:00 UTC, manual e push no script), com commit somente quando o TSE atualiza os dados.
- Catálogo de georreferenciamento `data/geo_loc/` (~1,8 MB): coordenadas verificadas dos 3.465 locais de votação de SC (fonte oficial TSE 2026; OSM só em lacunas; validação PIP/INEP/TRE-SC), 17.320/17.326 seções cobertas (99,97%), 295/295 municípios; gerado por `sync/geo_ref.py` e re-gerado por GitHub Actions (`geo-sync.yml`), com commit somente quando muda.
- Fallback CDN: `cdn.tse.jus.br` (CORS aberto), zip baixado uma única vez, unzip via fflate no navegador, cache em IndexedDB + memória.
- Exportação: SVG estático do mapa (com tooltips nativos) e dataset JSON.
- Interação do mapa: scroll = zoom, arrastar = mover, duplo clique = resetar.
- Testes: Node sem dependências (`node test/app_smoke.js`, `node test/snapshot_app.js`, `node test/tse_e2e.js` — este último requer `/tmp/tse_sc.zip`).

## Capabilities and Constraints

**Capacidades**
- 3 modos: (1) upload/drag&drop de JSON do usuário; (2) snapshot TSE (padrão) — lista de candidatos por cargo e mapa por número; (3) fallback CDN do TSE com progresso.
- Cargos: Deputado Federal, Deputado Estadual, Governador, Senador (zip SC) e Presidente (zip BR, filtrado para UF=SC). Só 1º turno.

**Invariantes (técnicas, não quebrar)**
- Posicionamento dos marcadores: **coordenadas verificadas dos locais de votação** (catálogo `data/geo_loc/`: fonte oficial TSE 2026, OSM só em lacunas, validação independente; cobertura de 99,97% das seções de SC). 1 marcador por local; seções do mesmo local são agregadas nele. Coordenadas pertencem ao local, nunca a candidato/cargo: a mesma seção sempre aparece no mesmo ponto, em qualquer candidato/cargo.
- MT19937 **bit-idêntico ao CPython** (seed = identidade da seção: muni IBGE + zona + seção) é usado **apenas** no modo ilustrativo (seções sem coordenada verificada, ou fallback sem catálogo): círculos ocos tracejados, rotulados "ilustrativo", exibidos somente por escolha explícita do usuário; nunca se mistura com marcadores verificados. A UI mantém a distinção entre o dado geográfico real (choropleth + locais verificados) e o modo ilustrativo.
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
- `data/geo_loc/` — catálogo de georreferenciamento (3.465 locais; 17.320/17.326 seções verificadas = 99,97%; 295/295 municípios) + `reports/geo_cobertura.json` (proveniência, hashes, status e validações por município).
- `test/` — suíte Node/Python (smoke, snapshot, e2e zip oficial vs dataset publicado, `geo_verify`/`geo_ref_check`/`geo_semantics`/`geo_pbf_roundtrip` para o catálogo e a semântica da UI).
- **Ausências a não inventar:** sem depoimentos, clientes, métricas de uso, preços ou claims de deploy além do GitHub Pages.

## Product Principles

1. **O dado não sai da máquina** — sem backend, sem upload; a consulta oficial é feita direto do navegador (CDN com CORS) ou no snapshot do próprio repositório.
2. **TSE é a única verdade** — dados oficiais exclusivamente; branco/nulo sempre excluído; sem fontes de terceiros.
3. **Determinismo** — a posição de cada seção depende só da identidade da seção (muni IBGE + zona + seção): coordenada verificada do local no catálogo (idêntica para qualquer candidato/cargo) ou, no modo ilustrativo, sorteio MT19937 ≡ CPython seedeado pela identidade; ordem do CSV preservada nos datasets; exemplo/snapshot/CDN idênticos.
4. **Zero dependência** — arquivos estáticos + fflate embutido; nada de npm/bundler.
5. **Vermelho, nunca azul** — identidade visual comprometida com vermelho como cor de destaque.
