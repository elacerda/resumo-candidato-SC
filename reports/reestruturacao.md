# Reestruturação eleitoral — revisão local

## A. Resumo executivo

Implementação local sobre `ef83bae`, em `main`, sem commit, push, merge, rebase,
limpeza ou alterações globais de Git. `.agents/` e `.codex/` continuam não rastreados.

- EA11/EA20 oficiais capturados, com cliente, normalizador e serviço eleitoral.
- Listagem nominal e agregados estaduais publicados em JSON pequeno; município/zona sob demanda.
- Turnos descobertos da configuração oficial; segundo turno presidencial disponível.
- 667 arquivos individuais substituem o carregamento do cargo inteiro no navegador.
- ZIP, IndexedDB de ZIP e descompactação removidos de `app.js` e da página.
- 24 legendas federais e 22 estaduais separadas das candidaturas históricas.
- Upload, exportações JSON/SVG, 1.336 locais verificados de 1333 e modo ilustrativo preservados.
- Sync com cache HTTP validado, origem/hash/identidade e artefato para revisão; sem publicação automática.

Limitação de aceitação: a suíte já tinha uma falha no rebuild geográfico contra o
catálogo publicado. Ela é explicitada abaixo; o catálogo não foi modificado para
fazê-la desaparecer. A implementação está disponível para revisão local, com essa
pendência preexistente.

## B. Fontes oficiais e evidência

Contrato, endpoints e campos: [ARCHITECTURE.md](../ARCHITECTURE.md).

Foram obtidos HTTP 200 para EA11, EA20 dos cinco cargos no primeiro turno em SC,
Presidente no segundo turno, Deputado Federal em Florianópolis e zona 12 desse
município. As capturas integrais estão em `test/fixtures/ea20/`, com URL, SHA-256 e
data de obtenção em `proveniencia.json`. O manifesto publicado fica em `data/ea20/index.json`.

A configuração real informa eleições **6257/6259** no primeiro turno e **6258** para
Presidente no segundo. Não há segundo turno de Governador em SC nessa configuração.
O normalizador usa `carg.agr.par.cand` para candidatos, preserva `vap/dvt/st/e` e
separa `tvtl/tval` partidários. Não confunde votos apurados com válidos. Contadores
originais `v/s`, inclusive anulados/sub judice, são preservados na normalização/exportação.

CORS foi observado com a origem `https://elacerda.github.io`; ETag e Last-Modified
foram recebidos e uma requisição If-None-Match retornou **304**. O teste real separado
confirmou novamente HTTP 200/CORS/304. Os testes locais simulam CORS e ausência de rede.
Espelhos estaduais são consultados na mesma origem; consultas territoriais dependem
do acesso ao TSE, com erro e retry se bloqueadas. Não existe fallback de ZIP.

Limites documentados: 100 requisições/s/IP; 304 conta; bloqueio por 10 minutos.
Cabeçalhos observados anunciavam 5000, sem serem adotados como contrato. Não houve
teste de carga. O link do PDF EA20 não entregou conteúdo legível nas tentativas;
o manual de download e os JSONs reais fundamentam o contrato implementado.

## C. Arquitetura final

`EA11 → ea20_sync.py → espelhos EA20 → ea20.js → electoral.js → painel agregado`

`ZIP oficial offline → tse_sync.py → snapshot_format.py → JSON individual + seções → snapshots.js → app.js → core.js/mapa`

EA20 e seção têm versões próprias. A interface apresenta fonte, abrangência, turno
e atualização. Sem seções, um agregado válido pode ser exibido sem criar seções ou
marcadores. A exportação agregada é separada do dataset do mapa.

`core.js`, catálogo geográfico e pipeline geográfico permanecem intactos. Cada ponto
verificado é um local; o modo ilustrativo continua explícito e visualmente separado.

## D. Arquivos relevantes

| Arquivo ou grupo | Finalidade |
| --- | --- |
| `js/ea20.js` | Cliente/cache, normalização e descoberta de eleições/cargos no EA11 |
| `js/snapshots.js` | Carrega somente um candidato; verifica identidade, referências e somas |
| `js/electoral.js` | Consulta fonte/abrangência sem mesclar modelos |
| `js/source-compare.js` | Guardião de comparabilidade; divergência comparável bloqueia publicação |
| `js/app.js` | Integração incremental; remove aquisição pesada; painel agregado, turnos e municípios |
| `js/tse.js` | Parser offline preservado; corrige exclusão de 96 e nomes branco/nulo sem distinção de caixa |
| `index.html` | Controles de turno/agregado/território; remove fflate/parser CSV do carregamento |
| `sync/ea20_sync.py` | Captura oficial e cache condicional; valida identidade/cadastro/degradação |
| `sync/tse_sync.py` | Processamento offline; valida ano/eleição/identidade/local; registra hashes oficiais |
| `sync/snapshot_format.py` | Publica arquivos/hashes por candidato e separa legenda sem heurística de tamanho |
| `sync/measure_payloads.py` | Medições exatas e alternativa serializada de 16 partições |
| `data/ea20/` | EA11, seis EA20 estaduais e manifesto de origem |
| `data/tse_2026/index.json` | Schema 2, candidatos/partidos, identidade eleitoral e proveniência |
| `data/tse_2026/candidatos/` | 667 arquivos individuais com pares originais seção/votos |
| `data/tse_2026/locais_secoes.json` | Índice de seção para código oficial do local |
| `data/tse_2026/municipios.json` | Lista leve de nomes/códigos/zonas para a interface |
| `data/tse_2026/proveniencia.json` | URLs e hashes dos ZIPs SC e BR |
| `.github/workflows/tse-sync.yml` | Geração/validação, cache e artefato; permissões somente de leitura |
| `test/fixtures/ea20/` | Respostas reais reproduzíveis, sem depender da rede nos testes locais |
| `test/electoral_data.js` | Contratos, categorias, filtros, falhas/CORS/cache, comparação e equivalência dos 667 candidatos |
| `test/snapshot_format_check.py` | Geração determinística, origem das capturas e cache HTTP simulado |
| `test/ea20_network.py` | Teste optativo de rede real, isolado da suíte local |
| `test/payload_http.py` | Medição de corpos via servidor HTTP estático local |
| `test/app_smoke.js`, `geo_semantics.js`, `geo_verify.js` | Shims carregam os novos módulos; as verificações geográficas permanecem |
| `test/snapshot_app.js`, `tse_panel_ux.js`, `ui_browser.js` | Novo cadastro nominal, indisponibilidade sem ZIP e novos fluxos de navegador |
| `README.md`, `PRODUCT.md`, `DESIGN.md`, `ARCHITECTURE.md` | Uso, limites, formato e identidade preservada |
| `reports/eleitoral_comparacao.json` | 667 comparações rastreáveis, com limites de comparabilidade explícitos |
| `reports/desempenho_eleitoral.json`, `desempenho_http.json` | Payloads medidos e método |

Não houve alteração de `style.css`, `js/core.js`, `data/geo_loc/`, `sync/geo_ref.py`,
`sync/geo_pbf.py` ou `.github/workflows/geo-sync.yml`. Os cinco arquivos legados de
cargo e a tabela `secoes.json` também permaneceram byte a byte idênticos.

## E. Integridade dos resultados

O rebuild completo a partir dos ZIPs SC+BR preservou os bytes dos cinco cargos e da
tabela de seções. Os 667 arquivos individuais preservam exatamente cada sequência
de pares `[índiceSeção,votos]` de seu arquivo legado. Somas, referências, municípios
e contagens são conferidos tanto no gerador quanto no cliente/testes. O cliente também
confere SHA-256 dos bytes de cada candidato e da tabela de seções antes de fazer o join;
testes alteram índices sem alterar votos e confirmam a rejeição de arquivos incompatíveis.

Referência **1333**: 4.876 votos, 3.397 seções, 224 municípios e 1.336 locais
verificados. Todos os registros, endereços e votos coincidem com o exemplo por
identidade `(município,zona,seção)`. O exemplo e o snapshot já tinham ordem global
diferente; a migração preservou a ordem de cada fonte. O posicionamento não depende
dessa ordem. Nenhuma coordenada foi alterada.

No cadastro EA20 capturado há 224 candidatos federais e 398 estaduais; no snapshot
histórico nominal há 229 e 404. Outros cargos: 8 governadores, 13 senadores e 13
presidenciais no snapshot, contra 12 presidenciais no EA20 do primeiro turno.
As 12 identidades ausentes no cadastro EA20 atual são preservadas no histórico:

- Federal: `1550,7777,7077,5093,2557`.
- Estadual: `50044,14007,36007,36358,18800,36123`.
- Presidente: `28`.

Há **655 correspondências de totais, sem divergência numérica**, e 12 registros
sem correspondência atual. Isso não autoriza afirmar igualdade de versões: o EA20
federal é de 24/10 e o CSV foi gerado em 26/10; o CSV não traz estado/instante de
totalização ou classificação jurídica por voto equivalentes. O relatório marca
comparabilidade não confirmada. `SQ_CANDIDATO` e `CD_ELEICAO` são conferidos quando
presentes, e nenhuma combinação de totais foi feita.

## F. Desempenho

Medição de **corpos JSON reais transferidos por HTTP local sem compressão**, conferida
contra os tamanhos em disco. Inclui índice, seções e, na versão nova, catálogo leve
de municípios; exclui malha, catálogo geográfico, código, cabeçalhos e recursos comuns.
Não representa medição de tráfego comprimido do GitHub Pages ou de latência em produção.

| Cargo / candidato | Arquivo antigo do cargo | Arquivo individual | Primeira consulta antes | Primeira consulta depois |
| --- | ---: | ---: | ---: | ---: |
| Federal 1333 | 7.079.788 B | 32.115 B | 8.728.312 B | 1.778.041 B |
| Estadual 22222 | 8.063.146 B | 174.704 B | 9.711.670 B | 1.920.630 B |
| Governador 22 | 905.114 B | 195.373 B | 2.553.638 B | 1.941.299 B |
| Presidente 22 | 1.033.703 B | 195.986 B | 2.682.227 B | 1.941.912 B |
| Presidente 28 | 1.033.703 B | 1.857 B | 2.682.227 B | 1.747.783 B |

Uma segunda consulta na mesma página reutiliza índice/tabela e carrega apenas outro
arquivo individual. A listagem EA20 é adicional caso o usuário a solicite.

A alternativa de 16 partições foi **serializada, não publicada**: para 1333, seriam
478.553 B de votos no grupo contra 32.115 B individuais. São medidas desses corpos
serializados, não transferências de um site alternativo. 667 arquivos foram considerados
um custo operacional aceitável; os legados conservados aumentam armazenamento sem
aumentar transferências normais do navegador.

Os ZIPs realmente obtidos para os testes têm **82.014.603 B (SC)** e
**241.891.087 B (BR)**, diferentes dos números antigos de documentação. Permanecem
somente em `/tmp`, fora do Git e fora do fluxo do navegador.

## G. Testes

Estado inicial registrado antes da implementação:

- Smoke, snapshot, painel TSE, semântica geográfica, catálogo e PBF passaram.
- Chrome, executado com autorização para servidor local, passou: 97 verificações
  de interface e 93 de rótulos. Tentativa inicial no sandbox não permitia abrir portas.
- E2E inicialmente não executável porque `/tmp/tse_sc.zip` não existia.
- `geo_ref_check.py` falhou **somente em `rebuild == publicado`**; duas reconstruções
  do cache eram idênticas entre si. Essa falha antecede qualquer alteração.

Execução final e comandos:

| Comando | Resultado |
| --- | --- |
| `node test/app_smoke.js` | Passou |
| `node test/snapshot_app.js` | Passou |
| `node test/tse_panel_ux.js` | Passou |
| `node test/geo_semantics.js` | Passou |
| `node test/geo_verify.js` | Passou |
| `node test/tse_e2e.js` | Passou com ZIP oficial; 1333 idêntico por identidade |
| `node test/ui_browser.js --shot` | Passou, 107 verificações, desktop/mobile, HTTP estático, upload/JSON/SVG, EA20/CORS/turnos |
| `node test/labels_browser.js` | Passou, 93 verificações |
| `python3 test/geo_pbf_roundtrip.py` | Passou |
| `python3 test/geo_ref_check.py` | Mesma falha inicial: `rebuild == publicado`; rebuild repetido é determinístico |
| `node test/electoral_data.js` | Passou, 667 arquivos; respostas oficiais e perturbações explícitas |
| `python3 test/snapshot_format_check.py` | Passou, 3 testes de determinismo/origem/cache |
| `python3 test/payload_http.py` | Passou, 20 corpos transferidos e conferidos |
| `python3 test/ea20_network.py` | Passou, rede real: HTTP 200, CORS da origem Pages e 304 |
| `python3 sync/tse_sync.py --out /tmp/resumo-audit/rebuild --zip-sc /tmp/tse_sc.zip --zip-br /tmp/tse_br.zip` | Passou; os cinco legados e tabela reproduzidos byte a byte |
| `git diff --check`, `node --check ...`, `python3 -m py_compile ...` | Passaram |

Logs desta sessão em `/tmp/resumo-audit/`; screenshots em `/tmp/uxshots2/`.
Nenhum teste depende da rede, exceto o comando explicitamente denominado `ea20_network.py`
e a obtenção prévia dos ZIPs para o E2E/rebuild.

## H. Pendências e riscos

1. Revisar separadamente a diferença preexistente entre catálogo publicado e rebuild
   do cache. O catálogo, suas fontes e o pipeline geográfico foram preservados.
2. Município/zona dependem de GET ao TSE no dispositivo. CORS foi confirmado, mas
   bloqueios de rede locais continuam possíveis; resultado estadual espelhado permanece disponível.
3. Não há polling. Uma recarga consulta a versão publicada; a atualização oficial
   de cada fonte é sempre mostrada. Nenhuma latência de produção foi medida.
4. Revisar as 12 candidaturas históricas sem correspondência EA20 atual, sem apagar
   votos nem presumir motivo jurídico para a ausência.
5. Não retomar publicação automática sem revisar a política de comparabilidade e
   a pendência geográfica. O workflow entregue produz apenas artefato para revisão.
6. Os legados continuam armazenados para compatibilidade offline. A remoção futura
   requer migrar os testes/consumidores restantes; o navegador já não os consulta.
7. O skill Impeccable identificou um sidecar `.impeccable/design.json` defasado em
   relação a DESIGN.md; ele não foi reparado como efeito colateral desta tarefa.

## I. Estado do Git

Nenhum commit ou push executado; HEAD permanece `ef83bae` em `main`.
`.agents/` e `.codex/` permanecem não rastreados e sem edição pelo trabalho.
Os arquivos novos ainda não adicionados ao Git não entram no `git diff --stat`.

### Captura final dos comandos Git

`git status --short`:

```text
 M .github/workflows/tse-sync.yml
 M DESIGN.md
 M PRODUCT.md
 M README.md
 M data/tse_2026/index.json
 M index.html
 M js/app.js
 M js/tse.js
 M sync/tse_sync.py
 M test/app_smoke.js
 M test/geo_semantics.js
 M test/geo_verify.js
 M test/snapshot_app.js
 M test/tse_panel_ux.js
 M test/ui_browser.js
?? .agents/
?? .codex/
?? ARCHITECTURE.md
?? data/ea20/
?? data/tse_2026/candidatos/
?? data/tse_2026/locais_secoes.json
?? data/tse_2026/municipios.json
?? data/tse_2026/proveniencia.json
?? js/ea20.js
?? js/electoral.js
?? js/snapshots.js
?? js/source-compare.js
?? reports/desempenho_eleitoral.json
?? reports/desempenho_http.json
?? reports/eleitoral_comparacao.json
?? reports/reestruturacao.md
?? reports/validacao_eleitoral.json
?? sync/ea20_sync.py
?? sync/measure_payloads.py
?? sync/snapshot_format.py
?? test/ea20_network.py
?? test/electoral_data.js
?? test/fixtures/
?? test/payload_http.py
?? test/snapshot_format_check.py
```

`git diff --stat`:

```text
 .github/workflows/tse-sync.yml |  56 +++++----
 DESIGN.md                      |  10 ++
 PRODUCT.md                     |  30 +++--
 README.md                      |  86 +++++++++-----
 data/tse_2026/index.json       |   2 +-
 index.html                     |  18 ++-
 js/app.js                      | 255 +++++++++++++----------------------------
 js/tse.js                      |   4 +-
 sync/tse_sync.py               | 124 ++++++++++++--------
 test/app_smoke.js              |   3 +
 test/geo_semantics.js          |   3 +
 test/geo_verify.js             |   6 +
 test/snapshot_app.js           |  13 ++-
 test/tse_panel_ux.js           |  21 ++--
 test/ui_browser.js             |  63 ++++++++--
 15 files changed, 380 insertions(+), 314 deletions(-)
```

`git ls-files .agents .codex`: saída vazia (nenhum arquivo rastreado).
