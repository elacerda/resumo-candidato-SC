# Reestruturação R02 — correções da auditoria independente

Data: 16/11/2026. Ambiente: **Tufão**, 16 GB de RAM compartilhada, Node 22,
Python 3 e Chrome headless real. Repositório acessado por `~/dev/resumo-candidato-SC`,
resolvido para `/storage/hdd/backup/dhubax/dev/resumo-candidato-SC`.

O relatório `~/Downloads/auditoria-resumo-candidato-SC.md` foi lido integralmente.
A rodada parte do trabalho R01 já presente e sem commit, em `main`, HEAD
`ef83baea9f75b26828e85bdaf7da231427ad3e78`. Nenhum commit, push ou publicação
foi executado. `.agents/` e `.codex/` não foram alterados.

## Achados investigados e correções

### P1 — divergências eleitorais sem bloqueio efetivo

**Confirmação:** `snapshot_format.py` escrevia `comparavel: false` e motivo fixo
em todas as entradas, sem afetar o exit code. O comparador JS era usado somente
por testes. O workflow gerava artefato sem executar uma decisão de promoção.

**Correção:** `sync/source_compare.py` implementa os eixos explícitos de comparação
(eleição, turno, cargo, UF, município, zona, categoria nominal, classificação jurídica,
andamento, totalização final e instante da atualização). O gerador chama esse
comparador para cada registro e grava os contextos, hashes, diferença e decisão:

- `coincidente`: contexto completo e igual, total igual; promoção automática elegível.
- `divergencia_bloqueante`: contexto completo e igual, total diferente; promoção proibida,
  inclusive mediante aprovação de versões independentes.
- `revisao_obrigatoria`: equivalência não comprovada ou identidade ausente no cadastro
  atual; promoção proibida até parecer humano vinculado ao SHA-256 do relatório.

Nenhuma coincidência de votos é usada para inventar equivalência de versões.
Evidências externas podem complementar apenas os eixos ausentes no CSV, precisam
identificar revisor, data e fontes e estar vinculadas aos hashes das duas entradas.
A ausência de um candidato não é classificada como voto nulo ou candidatura anulada.

A geração normal termina com erro quando há revisão pendente ou divergência.
`--review-only` gera diagnóstico, sem autorizar publicação. O comando de promoção
reconfere os hashes do índice, tabela compartilhada, arquivos individuais, legados,
manifesto EA20 e resultados agregados. Aprovação defasada não vale para outro relatório.

**Regressão negativa:** em cópia temporária, alterou-se `vap` de 1333 de 4.876 para
4.877, atualizando também o SHA-256 EA20, como no experimento da auditoria.
Sem comprovação temporal/jurídica, o gerador falha e registra diferença -1 em
`revisao_obrigatoria`; o gate retorna **2**. Com parecer **sintético, somente no teste**
que torna os contextos equivalentes, a mesma diferença passa a `divergencia_bloqueante`
e continua impedida. Os testes também verificam paridade Python/JS, invalidação de
parecer/hash, arquivo individual alterado e impossibilidade de aprovação de divergência
comparável. Nenhum parecer ou aprovação real foi fabricado.

**Dados reais:** 667 registros exigem revisão de versões: 655 totais coincidem e 12
não têm correspondência no cadastro atual. Nenhuma divergência numérica real foi
introduzida ou encontrada. O estado agregado permanece `revisao_obrigatoria`.

### P2 — exportação antiga e corridas de consulta

**Confirmação:** cargo/turno ocultavam apenas o painel, mantendo `aggregateExport`
e o botão; município/zona não expiravam o resultado. Os handlers assíncronos
escreviam na interface depois de qualquer troca de contexto.

**Correção:** `clearAggregateState()` limpa objeto exportável, conteúdo/metadados
do painel e botão. Cargo, turno, município e zona expiram também lista, contagem,
status e metadados. Município limpa a zona. Número, seleção e filtro invalidam o
agregado. Cada consulta recebe sequência monotônica; sucessos, erros, progresso e
finalizações antigos são ignorados. Uma finalização antiga não libera `tseBusy`
pertencente a uma consulta nova. A montagem do mapa também verifica atualidade
após carregar candidato, malha e catálogo.

**Regressões:** troca de cada eixo após um agregado exportável, tentativa programática
de exportar estado expirado, falha de rede após sucesso, sucesso atrasado em lista e
agregado, erro atrasado e finalização antiga durante consulta nova. Chrome real
exercita controles renderizados e uma resposta HTTP retida até depois da troca de cargo.

### P2 — candidaturas históricas inacessíveis pela lista normal

**Confirmação:** sucesso EA20 retornava exclusivamente seu cadastro; as 12 identidades
históricas só apareciam na falha ou por número digitado.

**Correção:** a lista traz grupos distintos `Cadastro atual EA20` e
`Histórico por seção — sem cadastro atual no EA20`. O segundo identifica votos por
seção e ausência de classificação jurídica por voto. O aviso informa a geração do
snapshot histórico separadamente da atualização EA20. Todos os históricos são
filtráveis e selecionáveis, sem somar seus votos aos agregados atuais.
Na indisponibilidade EA20, o grupo de fallback também declara essa condição.

Foram preservados federal `1550,7777,7077,5093,2557`, estadual
`50044,14007,36007,36358,18800,36123` e presidente `28`. A categoria continua
**nominal**; ausência no cadastro atual é um indicador histórico separado.

### P2 — classificação jurídica dos votos

**Confirmação:** `ea20.js` preservava `dvt`, mas `renderTseList()` não o exibia.

**Correção:** opções atuais mostram `votos apurados · <classificação EA20>`, incluindo
Anulado e Anulado sub judice. Metadados do índice conservam a classificação atual
com a proveniência EA20 já vinculada ao hash. O mapa a identifica como classificação
**da fonte EA20 atual**, declarando que o snapshot não informa classificação jurídica
por voto. Exportações mantêm os campos separados (`classificacao_snapshot: null` e
`classificacao_ea20`); não foi atribuída retroativamente validade a votos históricos.
`vap` nunca foi renomeado como votos válidos.

**Regressões:** as dez classificações anuladas/sub judice (6 federais, 3 estaduais,
1 senador) são verificadas individualmente nas opções. Um mapa anulado e um histórico
verificam os avisos. Todos os 667 datasets preservam categoria nominal e indicador
histórico independente.

### P3 — seleção posterior à digitação

**Confirmação:** `tseNum.value || tseSel.value` favorecia o número antigo.

**Correção:** mudar a seleção sincroniza `tseNum`; editar o número limpa a seleção.
O resultado agregado anterior também expira. Regressão com número 1333 digitado e
seleção posterior 2233 verifica o mapa efetivamente carregado e a sincronização no Chrome.

### P3 — operação de revisão, aprovação e promoção

O fluxo foi definido em `ARCHITECTURE.md` e conectado ao workflow. O cron continua
coletando/validando, com `contents: read`; não atualiza Pages automaticamente.
Um artefato `tse-revisao-<run_id>` fica disponível como diagnóstico, inclusive em falhas.
O workflow executa testes de interface/rótulos com Chrome e o gate eleitoral; somente
depois pode gerar `tse-elegivel-<run_id>`. A revisão precisa registrar hash exato do
relatório, revisor, data, decisão e justificativa. A integração posterior continua
manual, por revisão do conjunto exato e testes geográficos no Tufão. Branch protection
ou configuração externa do GitHub não foram alteradas.

O contrato do workflow tem regressão que exige browser/rótulos e gate antes do artefato
elegível, além de ausência de commit/push/permissão de escrita. O workflow remoto
não foi disparado nesta rodada; seus comandos foram exercitados localmente.

## Investigação da falha geográfica preexistente

`python3 test/geo_ref_check.py` foi executado **antes das correções** e novamente na
suíte completa. Ambos falharam somente em `rebuild == publicado`. Dois rebuilds
com as mesmas entradas atuais reproduzem bytes idênticos entre si.

A comparação completa, com o cache original do Tufão, encontrou:

| Arquivo | Diferença exata |
| --- | --- |
| `data/geo_loc/index.json` | `fontes.tse_2026.dt_geracao_tse` e a parcela correspondente de `gerado_em`: publicado `2026-10-06T14:03:43`, entrada atual `2026-10-26T12:07:25` |
| `data/geo_loc/locais.json` | Apenas ordem da coluna 7 (`secoes`) em 2.036 locais; conjuntos idênticos |
| `data/geo_loc/pendentes.json` | Apenas ordem de `secoes` em um registro pendente; conjunto idêntico |
| `data/geo_loc/secoes.json` | Bytes idênticos; todas as associações seção→local preservadas |

**Causa:** o catálogo publicado foi construído com geração e ordenação anteriores do
snapshot. `load_tse_snapshot()` lê a tabela compartilhada e a geração do índice atual;
`build_catalog()` acrescenta as seções na ordem de `snap_rows`; `publish()` serializa
essa ordem em cada local e pendência. `_gerado_em()` incorpora a geração do snapshot.
Assim, entrada eleitoral de outra geração/ordem explica a desigualdade de bytes.
O teste de rebuild compara as entradas atuais a um catálogo de geração anterior,
embora o pipeline seja determinístico sob entradas idênticas.

O diagnóstico valida também que a ordem reconstruída dos locais vem exatamente da
tabela compartilhada atual. Depois de comparar as listas de seções como conjuntos
e isolar **somente** os dois campos de geração, todos os demais atributos são iguais:
**0 coordenadas alteradas, 0 associações alteradas, 0 outras diferenças**. Os hashes
das fontes TSE/OSM/INEP/TRE-SC/revisões manuais permanecem iguais entre os catálogos.

A evidência com hashes dos quatro arquivos e contagens está em
[geo_rebuild_R02.json](geo_rebuild_R02.json). `test/geo_rebuild_diagnostic.py` reproduz
a comparação sem editar dados publicados; ele não substitui nem afrouxa o teste original.
A falha original permanece explícita. Nenhuma coordenada, associação, manifesto de
revisões ou código do pipeline geográfico foi alterado para fazer o teste passar.

## Arquivos alterados nesta rodada

| Arquivo | Alteração R02 |
| --- | --- |
| `sync/source_compare.py` (novo) | Decisão, aprovação vinculada e verificação de integridade antes da promoção |
| `sync/snapshot_format.py` | Comparação efetiva, contextos/hashes, evidências, classificação atual e bloqueio padrão |
| `sync/tse_sync.py` | Encaminhamento explícito de `--review-only`; padrão bloqueante preservado |
| `js/source-compare.js` | Estados de decisão e contrato igual ao Python |
| `js/app.js` | Estado/concorrência, exportação, grupos históricos, classificação e seleção |
| `js/snapshots.js` | Categoria nominal preservada e histórico/classificação desconhecida separados |
| `index.html` | Nome acessível do seletor de candidaturas/classificação |
| `data/tse_2026/index.json` | Classificações EA20 atuais por cargo/número; votos/seções individuais preservados |
| `.github/workflows/tse-sync.yml` | Diagnóstico separado de promoção, Chrome/rótulos e gate obrigatório |
| `test/source_compare_check.py` (novo) | Injeção real de divergência, decisões, paridade, hashes e workflow |
| `test/geo_rebuild_diagnostic.py` (novo) | Diagnóstico semântico completo, somente em saída temporária |
| `test/tse_panel_ux.js` | Regressões de todos os estados/seleções/históricos/classificações |
| `test/ui_browser.js` | Regressões em Chrome real, contagens com histórico |
| `test/electoral_data.js` | Contrato do comparador e classificação nominal/histórica dos 667 datasets |
| `test/snapshot_app.js` | Contagens de lista com históricos separados |
| `test/snapshot_format_check.py` | Determinismo em geração explícita para revisão |
| `ARCHITECTURE.md`, `README.md` | Procedimento operacional, comparabilidade e comportamento da UI |
| `reports/eleitoral_comparacao.json` | Regenerado com decisão efetiva e contexto por registro |
| `reports/desempenho_eleitoral.json`, `reports/desempenho_http.json` | Medições atualizadas após crescimento do índice de classificações |
| `reports/geo_rebuild_R02.json`, este relatório | Evidências e prestação de contas da rodada |

Os demais arquivos já modificados/não rastreados no início pertencem à rodada anterior;
o estado final do Git abaixo inclui ambos os trabalhos, sem atribuí-los todos à R02.

## Testes executados no Tufão

Após o aviso sobre RAM compartilhada, os testes pesados foram executados em
sequência, com um Chrome de testes por vez. Não foram encerrados programas do
usuário nem baixadas novas fontes grandes. Os ZIPs oficiais e os caches locais
existentes foram reutilizados. O sandbox inicialmente impediu a porta HTTP local
(`EPERM`); a execução real de navegador/HTTP/rede foi então autorizada fora dele.

| Comando | Resultado final |
| --- | --- |
| `node test/app_smoke.js` | Passou |
| `node test/snapshot_app.js` | Passou |
| `node test/tse_panel_ux.js` | Passou, incluindo todas as regressões R02 |
| `node test/geo_semantics.js` | Passou |
| `node test/geo_verify.js` | Passou, com CSV TSE e OSM do cache |
| `node test/tse_e2e.js` | Passou, ZIP SC oficial existente em `/tmp/tse_sc.zip` |
| `node test/electoral_data.js` | Passou, 667 candidatos, votos/ordem/hashes e classificação |
| `node test/ui_browser.js --shot` | Passou: **115 verificações**, Chrome real, desktop 1440×882 e mobile 390×844 |
| `node test/labels_browser.js` | Passou: **93 verificações**, incluindo densidade/colisões/zoom/exportação |
| `python3 test/snapshot_format_check.py` | Passou: 3 testes, incluindo geração determinística |
| `python3 test/source_compare_check.py` | Passou: 4 testes, incluindo injeção de divergência real no gerador e gate CLI |
| `python3 test/geo_pbf_roundtrip.py` | Passou |
| `python3 test/geo_ref_check.py` | **Falhou somente em `rebuild == publicado`**, mesma falha inicial; dois rebuilds atuais idênticos |
| `python3 test/geo_rebuild_diagnostic.py --rebuild-dir /tmp/resumo-R02/geo-rebuild --report reports/geo_rebuild_R02.json` | Passou; saída já reconstruída foi reutilizada para poupar CPU/RAM |
| `python3 test/payload_http.py` | Passou: 20 corpos HTTP reais conferidos |
| `python3 test/ea20_network.py` | Passou: EA20 oficial HTTP 200, CORS `https://elacerda.github.io` e condicional 304 |
| `python3 sync/measure_payloads.py` | Passou; relatório de tamanhos atualizado |
| `python3 sync/tse_sync.py --out /tmp/resumo-R02/snapshot-rebuild --zip-sc /tmp/tse_sc.zip --zip-br /tmp/tse_br.zip --review-only` | Passou; **677 JSONs** reproduzidos, sem diferença final de bytes |
| `python3 sync/source_compare.py` | **Código 2 esperado**: revisão obrigatória pendente; nenhuma promoção autorizada |
| `node --check`, compilação sintática Python e `git diff --check` | 32 verificações estáticas aprovadas |

O rebuild eleitoral revelou somente ordem de chaves distinta no índice intermediário,
com objetos JSON integralmente iguais. O índice foi reserializado a partir do rebuild
completo e o relatório foi regenerado para vincular o hash aos bytes finais. Os cinco
legados, a tabela compartilhada e os 667 arquivos individuais reproduzem seus bytes.
A idempotência foi novamente conferida após essa atualização. A integridade de
promoção foi exercitada também nessa situação: o gate recusou o relatório cujo hash
de índice ainda correspondia à serialização intermediária.

Medição com `/usr/bin/time -v`: maior RSS por comando foi **1.906.520 KiB (~1,82 GiB)**
no E2E do ZIP; reconstrução geográfica **519.552 KiB (~507 MiB)**; rebuild eleitoral
**489.692 KiB (~478 MiB)**. As medições são picos reportados por comando/processo,
não RAM total do sistema nem soma simultânea de todos os processos Chrome.
A observação do host durante a suíte mostrou aproximadamente 5,4 GiB disponíveis;
nenhuma execução concorrente de testes pesados foi iniciada após o aviso de memória.

Resultados e recursos por comando estão em
[reestruturacao-R02-testes.json](reestruturacao-R02-testes.json).
Logs completos, entradas temporárias e medições ficaram em `/tmp/resumo-R02/`;
capturas reais do Chrome estão em `/tmp/uxshots2/`. A inspeção de desktop/mobile
preservou a identidade visual e não encontrou overflow nas verificações do navegador.
O workflow remoto não foi executado, e não houve medição de tráfego/latência do Pages.

## Preservação e pendências

- **Preservação comprovada:** os 74 arquivos monitorados por SHA-256 no início
  permaneceram idênticos, incluindo `js/core.js`, pipeline/manifesto geográfico,
  catálogo `data/geo_loc/`, tabela `secoes.json`, workflow geográfico e arquivos
  locais de `.agents/`/`.codex/` incluídos na captura. O mapa e o georreferenciamento
  continuam com os mesmos dados e algoritmos.
- **Geografia:** resolver separadamente a atualização coerente do catálogo frente
  à geração/ordem do snapshot. A R02 explica a falha, mas não altera coordenadas,
  associações ou o teste de igualdade de bytes para escondê-la.
- **Revisão eleitoral:** as versões independentes exigem decisão humana explícita
  antes de promoção. Não há `reports/eleitoral_aprovacao.json`; o bloqueio atual é
  intencional. Nenhuma aprovação foi inferida do pedido de correções.
- **Operação:** a integração em `main` e a publicação permanecem manuais; não houve
  commit, push, disparo remoto ou mudança de configuração do GitHub.
- **Contexto visual preexistente:** o skill Impeccable reportou sidecar
  `.impeccable/design.json` anterior ao `DESIGN.md`. Não foi reparado como efeito
  colateral; a atualização pode ser solicitada pelo comando `document`.

## Estado final do Git

Branch `main`, HEAD `ef83baea9f75b26828e85bdaf7da231427ad3e78`, sem commit/push.
`git diff --cached --stat` não produz saída: nenhum arquivo foi colocado no stage.
O estado abaixo inclui o trabalho anterior já presente no início da sessão.

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
?? reports/geo_rebuild_R02.json
?? reports/reestruturacao-R02-testes.json
?? reports/reestruturacao-R02.md
?? reports/reestruturacao.md
?? reports/validacao_eleitoral.json
?? sync/ea20_sync.py
?? sync/measure_payloads.py
?? sync/snapshot_format.py
?? sync/source_compare.py
?? test/ea20_network.py
?? test/electoral_data.js
?? test/fixtures/
?? test/geo_rebuild_diagnostic.py
?? test/payload_http.py
?? test/snapshot_format_check.py
?? test/source_compare_check.py
```

`git diff --stat` (somente arquivos já rastreados):

```text
 .github/workflows/tse-sync.yml |  80 +++++++---
 DESIGN.md                      |  10 ++
 PRODUCT.md                     |  30 ++--
 README.md                      | 101 ++++++++----
 data/tse_2026/index.json       |   2 +-
 index.html                     |  20 ++-
 js/app.js                      | 346 ++++++++++++++++++-----------------------
 js/tse.js                      |   4 +-
 sync/tse_sync.py               | 125 +++++++++------
 test/app_smoke.js              |   3 +
 test/geo_semantics.js          |   3 +
 test/geo_verify.js             |   6 +
 test/snapshot_app.js           |  13 +-
 test/tse_panel_ux.js           | 129 +++++++++++++--
 test/ui_browser.js             | 111 ++++++++++++-
 15 files changed, 646 insertions(+), 337 deletions(-)
```

`git diff --check`: passou. `git ls-files .agents .codex`: saída vazia.
