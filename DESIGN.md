---
name: Resumo Candidato — SC
description: Mapa interativo de seções de votação com voto de um candidato em Santa Catarina (Eleições 2026) — ferramenta de dados eleitoral, dark, vermelho.
colors:
  bg: "#0e1319"
  panel: "#161d27"
  panel-hover: "#1a2432"
  line: "#2a3543"
  line-accent: "#7a353b"
  fg: "#e8eef5"
  muted: "#8fa0b3"
  accent: "#f63b4b"
  accent-strong: "#dc2626"
  accent-deep: "#b91c1c"
  accent-light: "#fd939c"
  marker: "#ffb454"
  ok: "#34d399"
  warn: "#fbbf24"
  err: "#f87171"
  input-bg: "#0b0f14"
  tip-border: "#3a4a5f"
typography:
  brand:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "15.5px"
    fontWeight: 700
    letterSpacing: "0.2px"
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  small:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
  button:
    fontFamily: "system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  mono:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "12px"
    lineHeight: 1.55
rounded:
  control: "8px"
  surface: "12px"
  panel: "14px"
  hero: "16px"
  tip: "6px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "14px"
  xl: "18px"
  section: "26px"
components:
  button-primary:
    backgroundColor: "{colors.accent-strong}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-primary-hover:
    backgroundColor: "{colors.accent-deep}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.fg}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-secondary-hover:
    backgroundColor: "{colors.panel-hover}"
    textColor: "{colors.fg}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-link:
    backgroundColor: "transparent"
    textColor: "{colors.accent-light}"
    rounded: "{rounded.control}"
    padding: "0px"
  input-field:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
  chip:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.fg}"
    rounded: "{rounded.pill}"
    padding: "5px 13px"
  chip-metric:
    backgroundColor: "rgba(246,59,75,0.07)"
    textColor: "{colors.fg}"
    rounded: "{rounded.pill}"
    padding: "5px 13px"
  tooltip:
    backgroundColor: "rgba(23,30,40,0.97)"
    textColor: "{colors.fg}"
    rounded: "{rounded.tip}"
    padding: "8px 10px"
  hud:
    backgroundColor: "rgba(22,29,39,0.92)"
    textColor: "{colors.fg}"
    rounded: "{rounded.control}"
    padding: "9px 13px"
---

# Design System: Resumo Candidato — SC

## Overview

**Creative North Star: "A Cabine de Transparência"** (nome de trabalho, a confirmar com o dono)

A cabine de votação é o símbolo do produto: um espaço fechado onde o voto acontece e, ao
mesmo tempo, onde tudo é auditável. O app herda esse dualismo — a interface é escura e
contida (a sala), mas cada dado exibido é verificável e declarável (a transparência). A
estética é a de uma ferramenta de apuração: densidade alta, ruído zero, e a cor de
destaque vermelha usada com contenção.

A densidade é a de um painel operacional, não de uma página de marketing: base 14px,
chips e HUDs compactos sobre o mapa, e a maior parte da área da tela entregue ao SVG.
O mapa é o protagonista absoluto; toda a UI orbital (topbar, chips, HUD, legendas,
tooltip) existe para servir a leitura dos dados sem competir com eles.

A identidade emocional é de honestidade técnica: quando a UI não pode mostrar algo com
certeza, ela o declara (georreferenciamento indisponível, modo ilustrativo, seções sem
coordenada). A clareza sobre o que é dado real e o que é ilustração é uma decisão de
design, não apenas de código.

**Key Characteristics:**
- Dark apenas; vermelho de destaque contido, laranja exclusivo dos marcadores de dados.
- Mapa SVG é o herói; UI orbital compacta (chips, HUD, tooltip).
- Dois idiomas de marcador, nunca misturados: laranja cheio = local verificado; círculo oco tracejado vermelho = ilustrativo.
- Estado sempre declarado (aria, HUD, legenda e aviso em conjunto).
- pt-BR, tom de ferramenta; zero ornamento que não sirva à leitura do dado.

## Colors

Paleta única dark; um acento (vermelho) e um cor de dado (laranja), com neutros
azulados frios para superfícies.

### Primary
- **Vermelho Oficial** (`accent` #f63b4b): acento de estado e ênfase — foco, barras de progresso, bordas ativas, links, marcadores ilustrativos. `accent-strong` #dc2626 (botão primário) e `accent-deep` #b91c1c (hover) formam a escala de interação; `accent-light` #fd939c é o texto claro de destaque (links, badges, legendas) legível no fundo escuro.
- **Laranja Seção** (`marker` #ffb454): cor exclusiva dos marcadores de dados (locais de votação verificados). Nunca é cor de UI interativa.

### Secondary
- **Verde Apuração** (`ok` #34d399): confirmação (ex.: snapshot disponível).
- **Âmbar Aviso** (`warn` #fbbf24): avisos não bloqueantes (arquivo grande, seções sem coordenada).
- **Vermelho Erro** (`err` #f87171): falhas (redes, JSON inválido) — distinto do acento por matiz mais claro.

### Neutral
- **Noite** (`bg` #0e1319): fundo base, com gradiente radial sutil mais claro no topo.
- **Painel** (`panel` #161d27): cards, botões secundários, chips, HUDs (com opacidade 0.92 quando flutuante).
- **Borda** (`line` #2a3543): separadores e bordas neutras.
- **Borda Acento** (`line-accent` #7a353b): bordas com peso de acento (dropzone, chips métrica, stroke do choropleth).
- **Texto** (`fg` #e8eef5) e **Cinza-Borda** (`muted` #8fa0b3): hierarquia de texto.
- **Poço** (`input-bg` #0b0f14): campos de input e blocos de código (mais escuros que o fundo, para "recuar").

### Named Rules
**The Vermelho, Nunca Azul Rule.** O acento de interação é vermelho em todas as suas
escalas. Azul está vetado como cor de destaque (compromisso de marca registrado em
PRODUCT.md). O tom frio dos neutros não é "azul de interface": é o desaturo necessário
de um dark.

**The Cor de Dado Rule.** O laranja #ffb454 pertence apenas a marcadores de dados
(marcadores de local/seção). A UI interativa nunca veste a cor do dado; o dado nunca
vêste a cor da UI.

## Typography

**Body Font:** system-ui stack (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`)
**Mono Font:** `ui-monospace, "SF Mono", Menlo, Consolas` (exemplos de JSON, código TSE)

**Character:** um único family sem serifa do sistema, com hierarquia construída por
tamanho pequeno (11.5–14px) e peso (400/500/600/700) — a tipografia de um painel de
controle, não de uma editoria.

### Hierarchy
- **Brand** (700, 15.5px, tracking 0.2px): nome do app na topbar, com badge "SC".
- **Title** (700, 21px): hero no painel TSE (“Mapa de seções por candidato…”, landing TSE-first). O título do dropzone (ação secundária) segue 15.5px/700.
- **HUD title** (700, 15.5px) + **HUD sub** (400, 11.5px, muted): identificação do mapa e linha de métricas sobre o mapa.
- **Body** (400, 14px/1.55): texto base.
- **Small** (400, 12.5–13px): painéis, chips, avisos, tooltips.
- **Label** (500, 11.5px; legendas do mapa em 9–10px): chaves de chips, subtítulos de legenda.
- **Mono** (12px): amostra do formato JSON e código.

### Named Rules
**The Small-But-Clear Rule.** Tamanhos mínimos são 9px (legenda do mapa) e 11.5px (rotulagem)
com contraste ≥ 6.8:1 (muted sobre bg); abaixo disso, o texto deixa de ser informação.

## Layout

Contêiner central `max-width: 1160px`, padding horizontal 18px. Uma coluna vertical:
topbar sticky (altura ~51px no desktop, empilhada no mobile) → painel TSE
(visível por padrão — landing TSE-first; recolhido automaticamente ao carregar o
mapa) → dropzone (ação secundária) **ou** resultados (chips → ações → mapa). O mapa
ocupa a largura do contêiner com altura proporcional (SVG `viewBox` 1008×711, `height: auto`).

Camadas sobre o mapa: HUD de título (topo-esquerda, `max-width: min(75%, 640px)`),
controles de zoom (topo-direita, coluna de 3 botões de 34px no desktop, 44px no
mobile), legenda (base-direita, overlay no desktop). Em ≤640px a topbar empilha
(brand acima das ações), o HUD de título fica com `max-width: calc(100% - 78px)` à
esquerda dos botões de zoom, e a legenda sai do overlay: em fluxo, sob o mapa, com
fonte ampliada (11px/10px) — sem sobreposição com HUD/zoom por construção.

Ritmo vertical: 14px entre blocos dos resultados, 18px entre seções, 26px no padding
superior do contêiner. Densidade compacta: botões 7px/14px, chips 5px/13px.

## Elevation & Depth

Sistemabasicamente flat: profundidade por **tonal layering** (painéis 6–8% mais claros
que o fundo; camadas flutuantes em `rgba(22,29,39,0.92)`) e por **bordas** (`--line`),
não por sombras. Sombras existem em exatamente dois lugares: o tooltip (única camada
que cobre o mapa) e o gradiente radial do fundo.

### Shadow Vocabulary
- **Tooltip** (`box-shadow: 0 6px 18px rgba(0,0,0,0.5)`): única sombra estrutural do app.

### Named Rules
**The Flat-By-Default Rule.** Superfícies são flat em repouso; profundidade vem de
contraste tonal (0e1319 → 161d27 → 1a2432) e borda, não de sombra.

## Shapes

Linguagem de cantos arredondados suaves em duas faixas: controles 8px (botões, inputs,
HUD, tooltip 6px), containers 12–16px (mapa 12px, painel 14px, dropzone 16px), e pills
(999px) apenas para chips e badge. A dropzone usa borda tracejada 2px (afinidade com o
linguagem "arraste aqui" do drag&drop), que ecoa os círculos ocos tracejados dos
marcadores ilustrativos — o tracejado é o padrão visual de "não é dado finalizado".

## Components

### Buttons
- **Shape:** raio 8px; padding 7px 14px; fonte 600 13px.
- **Primary:** `accent-strong` #dc2626, texto branco, borda igual ao fundo; hover `accent-deep` #b91c1c. Reserva da ação principal ("Mostrar mapa", "Dados do TSE (2026)").
- **Secondary:** `panel` #161d27 com borda `line`; hover: borda `line-accent` + fundo `panel-hover`. Ações neutras (Trocar candidato, Baixar SVG).
- **Link:** transparente, `accent-light` sublinhado (offset 3px) — entrada alternativa dentro de texto.
- **Zoom (mapa):** quadrados 34px (+/−/⟲) no desktop, 44px no mobile (alvo de toque), com fundo semi-opaco `rgba(22,29,39,0.92)`, coluna no canto do mapa, `aria-label` em cada um. No mobile, todo `.btn` tem `min-height: 44px`.
- **Estado ativo do toggle** (`btnTse`): borda `accent` + fundo `rgba(246,59,75,0.18)`.
- **Focus:** `outline: 2px solid accent` com offset 2px em botões, links, inputs e rádios.

### Chips
- **Style:** pill, `panel` com borda `line`, 12.5px/600; a chave tem 11.5px muted (`.k`).
- **Metric variant:** borda `line-accent` + fundo `rgba(246,59,75,0.07)` — separa identidade (candidata/o, número, cargo, fonte) de métricas (votos, seções, municípios, cobertura).

### Cards / Containers
- **Corner Style:** 12–16px conforme escala (mapa 12, painel TSE 14, dropzone 16).
- **Background:** `panel` a 55–60% de opacidade sobre o fundo; sem sombra.
- **Border:** 1px `line` (neutro) ou `line-accent` (dropzone, em dragover vira `accent`).
- **Internal Padding:** 18px 20px (painel; 14px 16px no mobile), 30px 24px 26px (dropzone, ação secundária — compacta de propósito).

### Inputs / Fields
- **Style:** fundo `input-bg` #0b0f14, borda `line`, raio 8px, 13px; `tseNum` 170px, `tseSel` até 420px (lista com `size=8`).
- **Focus:** outline acento 2px.
- **Rádios de cargo:** `accent-color: var(--accent)`; agrupados em `fieldset` com legend "Cargo".

### Tooltip
- **Style:** `rgba(23,30,40,0.97)`, borda `tip-border` #3a4a5f, raio 6px, 12px/1.45, `max-width: 300px`, sombra única do app.
- **Estrutura:** título (700 12.5px), município (muted), linhas de contexto (muted), valor em destaque (`marker`, 700) e nota em itálico quando a posição é ilustrativa.
- **Comportamento:** segue o mouse (offset 14px, inverte perto da borda da viewport); em touch, abre no tap e fecha no tap fora.

### HUD (painéis sobre o mapa)
- **Style:** `rgba(22,29,39,0.92)`, borda `line`, raio 8px, `pointer-events: none`.
- **Título:** nome do candidato + número + cargo + linha de métricas (eleição, votos, seções, municípios, locais verificados / estado do georreferenciamento).
- **Legenda:** “votos por município (escala log):” + rampa (8 swatches de opacidade) + linha “0 … máximo (município)”; depois a linha do marcador: “local de votação (verificado) · tamanho = votos no local (satura a partir de 5)” — o raio codifica os votos agregados (Core.dotR), nunca o número de seções e nunca com relação linear ilimitada. Linha ilustrativa só quando há o que ilustrar (seções sem coordenada ou modo ilustrativo ativo): nunca um símbolo morto na legenda.

### Mapa SVG (componente-assinatura)
- **Choropleth:** preenchimento `accent` com opacidade log2 (0.12→0.85) sobre a base `panel`; municípios sem voto usam `panel` + borda `line`; borda dos preenchidos em `line-accent`.
- **Marcador verificado (local):** círculo `marker` opacidade 0.9, stroke `rgba(255,255,255,0.25)`; raio ∝ votos agregados do local (1.3px/1 voto → 4.0px/5+ votos), constante na tela durante zoom (`vector-effect: non-scaling-stroke` + reescala de raio).
- **Marcador ilustrativo:** círculo oco, stroke `accent` tracejado (2 1.5) — mesma escala de raio; nunca preenchido.
- **Rótulos de município (adaptativos):** nome (11px/600, `fg`, halo 3px `bg`) no maior anel + linha de votos (9.5px, muted) somente com zoom (vb.w ≤ metade do estado). Sem limiar absoluto de votos: todos os municípios com voto > 0 são candidatos, em prioridade de votos (desempate por IBGE); a visibilidade é decidida por colisão entre caixas reais do texto renderizado (getBBox) com gap mínimo de 14px de tela — mais rótulos em telas largas, menos no mobile; ao zoom/pan (loteado em rAF) novos rótulos são revelados sem sobreposição. Os painéis flutuantes opacos (HUD/legenda/botões de zoom) são obstáculos: um rótulo que cairia embaixo deles desvia deterministicamente (cima → baixo → esquerda → direita), com desvio limitado por eixo ao menor de (extensão do próprio painel + gap) e 4×(gap + tamanho do rótulo) — sem teleporte que desligue o rótulo da posição do município; sem desvio válido, o rótulo fica oculto e só reaparece quando o zoom/pan traz a âncora para fora do painel (no mobile o HUD cobre a parte de cima do mapa no zoom total: os municípios do norte são rotulados com zoom/pan na região; a legenda sai do mapa no mobile — `position: static`). Votos também disponíveis por interação (hover/click no polígono do município). O export SVG usa o mesmo layout na escala base (só nomes, sem colisão; sem obstáculos — o arquivo nunca carrega a posição dos painéis).
- **Interação:** wheel = zoom (cursor centrado; ctrl+wheel = pinch do trackpad), arrastar (mouse) = pan, 1 dedo = pan, pinch de 2 dedos = zoom centrado nos dedos, duplo clique = reset, botões +/−/⟲ como alternativa de teclado. `touch-action: none` vale apenas para o SVG do mapa — o scroll da página fora do mapa não é afetado.

## Do's and Don'ts

### Do:
- **Do** manter o mapa como herói: UI orbital compacta, sem barras de navegação, sem footer, sem decoração.
- **Do** usar `accent-light` (#fd939c) para texto de destaque no dark — o `accent` puro tem contraste insuficiente para texto pequeno.
- **Do** declarar o estado do georreferenciamento em quatro lugares juntos (aria do SVG, HUD, legenda e aviso) sempre que o mapa sair do modo verificado.
- **Do** distinguir os dois idiomas de marcador com preenchimento vs. oco+tracejado (e rotulá-los na legenda).
- **Do** respeitar `prefers-reduced-motion`: sem transições CSS e com scroll instantâneo (`behavior: auto`) quando o usuário pediu redução de movimento.
- **Do** manter pt-BR e tom de ferramenta ("mostrar", "carregar", "baixar") em toda a copy.

### Don't:
- **Don't** usar azul como cor de destaque — veto de marca absoluto.
- **Don't** pintar marcadores de dados com o acento vermelho; o laranja é cor de dado.
- **Don't** adicionar sombra a superfícies (tooltip é a exceção única).
- **Don't** misturar marcador verificado e ilustrativo sem o rótulo de modo ativo.
- **Don't** introduzir light mode, bundler ou dependência npm.
