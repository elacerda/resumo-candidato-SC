# Arquitetura eleitoral estática

## Fontes e limites

O contrato foi conferido em 16/11/2026 na [configuração EA11 oficial](https://resultados.tse.jus.br/oficial/comum/config/ele-c.json),
na [documentação técnica do TSE](https://www.tse.jus.br/eleicoes/informacoes-tecnicas-sobre-a-divulgacao-de-resultados)
e em respostas reais, preservadas em `test/fixtures/ea20/`. O manual de download
vigente é a versão 1.1 de 19/10/2026. O link de especificação EA20 não forneceu
texto/PDF legível nas tentativas desta sessão; o normalizador implementa apenas a
estrutura efetivamente observada nas capturas. Não há contrato presumido por seção.

EA11 anuncia ciclo `ele2026`, eleição federal 6257 e estadual 6259 no primeiro turno,
e presidencial 6258 no segundo. Cargos: Presidente 1, Governador 3, Senador 5,
Deputado Federal 6, Deputado Estadual 7. Esses códigos são descobertos no sync,
não fixados no cliente. A eleição estadual 6260 de segundo turno tem abrangências
específicas que **não incluem SC**. O cliente não inventa um segundo turno estadual.

URLs verificadas:

- `https://resultados.tse.jus.br/oficial/comum/config/ele-c.json`
- `https://resultados.tse.jus.br/oficial/ele2026/6259/dados/sc/sc-c0006-e006259-u.json`
- Mesmo padrão estadual para cargos 3, 5 e 7, e federal 6257/cargo 1.
- `https://resultados.tse.jus.br/oficial/ele2026/6258/dados/sc/sc-c0001-e006258-u.json`
- `https://resultados.tse.jus.br/oficial/ele2026/6259/dados/sc/sc81051-c0006-e006259-u.json`
- `https://resultados.tse.jus.br/oficial/ele2026/6259/dados/sc/sc81051-z0012-c0006-e006259-u.json`

O padrão de zona inclui município e zona com quatro dígitos, conforme manual.
Só os exemplos acima foram testados ao vivo; as outras combinações territoriais
são construídas conforme o contrato e podem responder indisponibilidade.

Campos observados e utilizados:

| Objeto | Campos | Uso |
| --- | --- | --- |
| EA11 | `pl.c`, `e.cd`, `e.t`, `abr.cd`, `cp.cd/ds`, `arq` | Descoberta de eleição, turno, abrangência e cargo; organização de diretórios conferida no manual |
| EA20 | `ele,t,f,tpabr,cdabr` | Identidade; somente ambiente oficial, SC na origem estadual |
| EA20 | `dg,hg,dt,ht,idg,and,tf` | Geração, atualização e situação de totalização, preservadas sem conversão de fuso presumida |
| Cargo | `carg.cd,nmn,agr.par` | Separação de cargos e agrupamentos partidários |
| Candidato | `n,sqcand,nm,nmu,vap,dvt,st,e` | Número, identidade, nomes, votos apurados, classificação, situação e eleito |
| Partido | `n,nm,sg,dvt,tvtl,tval` | Legenda apurada/válida separada dos votos nominais |
| Totais | `v`, `s` | Contadores oficiais originais, inclusive válidos, nominais, legenda, anulados, sub judice, branco/nulo e seções |

`vap` não é renomeado como “votos válidos”: candidaturas com `dvt=Anulado` ou
`Anulado sub judice` continuam explicitamente classificadas. Não somar indiscriminadamente
`vap` para produzir o total de votos válidos. Dados municipais/zonais não fornecem
neste contrato a lista de votos individuais por seção.

## CORS, cache e atualização

GET com `Origin: https://elacerda.github.io` retornou o mesmo valor em
`Access-Control-Allow-Origin`, inclusive no EA20 federal estadualizado consultado.
ETag e Last-Modified foram observados; If-None-Match retornou **304**.
O teste separado `python3 test/ea20_network.py` permite verificar novamente.
Não há polling no site. O cache do cliente dura a página; falhas são removidas do
cache para permitir nova tentativa. Uma recarga consulta a versão publicada.

O TSE documenta 100 requisições/s/IP, bloqueio por 10 minutos e que 304 também
conta no limite. Os cabeçalhos observados anunciavam 5000; eles não substituem
o limite documentado. O sync é sequencial, sem rajadas. Nenhum limiar de 404 foi
publicado; não se faz descoberta por tentativas de endpoints.

Os resultados estaduais são espelhados na mesma origem (`data/ea20/`) pelo Actions.
Assim, listagem/resultado estadual não dependem do CORS do TSE no dispositivo.
Municípios e zonas usam GET direto sob demanda, cujo CORS foi confirmado nos
cabeçalhos. Bloqueio local, CORS ausente, 403 ou falha de rede geram mensagem e retry;
não acionam ZIP nem dados artificiais. O teste de navegador usa capturas oficiais
com CORS permitido e simula bloqueio separadamente; ele não depende da rede real.

## Fluxo e módulos

1. `ea20_sync.py` lê EA11, filtra o ciclo e abrangência e captura os EA20 disponíveis.
   Valida identidade, cadastro e conservação de cargos/turnos antes de escrever o manifesto.
2. `tse_sync.py` processa os ZIPs offline. Filtra SC, ano 2026 e primeiro turno;
   preserva CD_ELEICAO, SQ_CANDIDATO, NR_LOCAL_VOTACAO, geração, ordem e votos.
3. `snapshot_format.py` valida cada referência e soma e publica um arquivo por
   candidato. Legenda é classificada pelo identificador oficial do CSV e confirmada
   no cadastro partidário EA20. Não depende do comprimento do número.
4. No navegador, `ea20.js` normaliza agregados; `snapshots.js` valida e reconstrói um
   candidato; `electoral.js` decide a consulta e preserva a independência das fontes.
5. `app.js` mantém interface, upload, mapa, tooltips, zoom/pan e exportações. A lista
   prefere EA20; o mapa prefere as seções oficiais. Agregados têm painel/exportação
   próprios. Sem seções, o agregado pode ser mostrado, sem inventar mapa granular.
6. `core.js` e `data/geo_loc/` permanecem inalterados. Um marcador é um local
   verificado; seções desse local compartilham a coordenada. O modo ilustrativo
   continua sendo escolha explícita, com símbolos e avisos separados.

## Formato publicado e decisão de particionamento

```
data/ea20/index.json                  # eleições/cargos/turnos disponíveis, URLs/hashes/datas
data/ea20/<cargo>-<turno>.json         # bytes EA20 oficiais
data/ea20/ele-c.json                  # bytes EA11 oficiais
data/tse_2026/index.json              # schema 2; candidatos e partidos separados
data/tse_2026/secoes.json             # tabela compartilhada original, sem alteração
data/tse_2026/municipios.json         # nomes/códigos/zonas, sem votos
data/tse_2026/locais_secoes.json      # índice da seção → NR_LOCAL_VOTACAO oficial
data/tse_2026/candidatos/<cargo>/<numero>.json
                                     # identidade + [[idxSecao,votos], ...]
data/tse_2026/proveniencia.json       # hashes dos ZIPs oficiais
data/tse_2026/<cargo>.json            # compatibilidade offline; nunca solicitado pelo app
```

Foram escolhidos **667 arquivos individuais**, um número operacionalmente moderado,
sem árvore de dependências adicional. A alternativa com 16 partições por cargo foi
serializada e medida: para 1333, um grupo teria 478.553 bytes contra 32.115 bytes do
arquivo individual com identidade oficial. As partições economizariam arquivos,
mas transfeririam votos de outros candidatos. As medições completas estão em
`reports/desempenho_eleitoral.json`, reproduzíveis com `python3 sync/measure_payloads.py`.
Os arquivos legados continuam no repositório para testes e diagnóstico, com custo
adicional de armazenamento; removê-los exige migrar os consumidores offline existentes.

## Integridade e rastreabilidade

EA20: manifesto registra URL, eleição, turno, obtenção da versão, atualização oficial,
SHA-256 e esquema. As fixtures têm manifesto próprio. A data de obtenção vem da
captura; não é inventada a partir da data eleitoral. No cache HTTP, bytes idênticos
mantêm a primeira data de obtenção da versão, evitando mudanças artificiais. Arquivos
locais dos ZIPs têm hash e geração documentados; a data de obtenção operacional do
download fica no cache HTTP quando o sync faz a aquisição.

Snapshots: validação de ano/UF/turno, código de eleição, identidade do candidato,
identidade do local por seção, índices únicos, votos inteiros positivos, soma por
município, contagem de seções/municípios e total do índice. Antes do join, o navegador
verifica SHA-256 dos bytes do candidato e da tabela compartilhada com Web Crypto
(HTTPS ou localhost), impedindo mistura silenciosa de versões do índice de seções. Erros interrompem a geração.
A validação compara SQ_CANDIDATO entre fontes quando o cadastro atual contém o número.
As 12 candidaturas sem correspondência atual não são apagadas; ficam identificadas.

`source-compare.js` exige eleição, turno, cargo, território, categoria, classificação jurídica, estado e instante
de totalização confirmados e iguais antes de autorizar comparação numérica. Uma
comparação válida divergente retorna `publicar=false`. Os testes verificam esse bloqueio.
O relatório real não presume comparabilidade: o CSV não fornece instante/estado de
totalização ou classificação jurídica individual equivalentes ao EA20. Todos os
655 totais com correspondência coincidiram, mas isso não prova igualdade de versões.
Não há mescla de fontes. As comparações que exigem interpretação permanecem para revisão.

## Sincronização e publicação

O workflow usa `contents: read` e produz artefato validado para revisão. Nenhum passo
commita ou faz push. A captura EA20 falha se uma resposta obrigatória estiver inválida
ou se um cargo/turno anteriormente publicado desaparecer. O snapshot é gerado somente
após a captura válida. Qualquer teste falho impede a etapa de artefato bem-sucedida.

Downloads grandes são reutilizados somente após validação condicional HTTP 304 e
conferência de SHA-256. Sem validador, a fonte é baixada novamente; sem rede, o sync
falha em vez de tratar cache antigo como atualização. A primeira execução pode baixar
os ZIPs completos; execução offline explícita aceita `--zip-sc` e `--zip-br`.
Conteúdo idêntico produz os mesmos bytes; geração sem data oficial é erro.
O pipeline geográfico não foi modificado.

## Reprodução local

```
python3 sync/ea20_sync.py --fixtures test/fixtures/ea20 --out /tmp/ea20
python3 sync/tse_sync.py --out /tmp/tse-rebuild --ea20 /tmp/ea20 \
  --zip-sc /tmp/tse_sc.zip --zip-br /tmp/tse_br.zip --review-only
node test/electoral_data.js
python3 test/snapshot_format_check.py
python3 -m http.server 8000
```

Abra `http://localhost:8000/`. Não é necessário npm, bundler ou backend.
A suíte completa e as limitações observadas estão em `reports/reestruturacao.md`.

## R02: decisão efetiva de promoção

`sync/source_compare.py` aplica no gerador a mesma decisão de `js/source-compare.js`,
com teste de paridade. Os eixos obrigatórios são eleição, turno, cargo, UF,
município, zona, categoria nominal, classificação jurídica, andamento, totalização
final e instante de atualização. Vazio em município/zona significa abrangência
estadual; ausência significa desconhecido. Coincidência numérica não comprova versão.

O CSV não informa classificação jurídica e instante/estado de totalização por voto.
Por isso, o conjunto atual fica em `revisao_obrigatoria`, inclusive os 655 totais
coincidentes e as 12 candidaturas sem cadastro atual. O gerador normal retorna erro
após escrever o relatório. `--review-only` gera arquivos candidatos à revisão,
sem autorização de promoção. Divergência comprovadamente comparável recebe
`divergencia_bloqueante` e nenhuma aprovação pode superá-la.

Quando houver evidência documental de equivalência, `snapshot_format.py --evidence`
aceita JSON por cargo/número com `snapshot_sha256` (arquivo legado do cargo),
`ea20_sha256`, `revisor`, `revisado_em`, `evidencias` e `contexto_snapshot`.
Este último só pode complementar `classificacao`, `andamento`, `totalizacaoFinal`
e `atualizado`; os demais eixos vêm das fontes. Os hashes precisam corresponder
às versões efetivamente comparadas. Não há parecer de equivalência criado nesta rodada.

### Revisão e promoção manual

1. Executar o workflow ou gerar em checkout de revisão com `tse_sync.py --review-only`.
   O artefato `tse-revisao-<run_id>` é diagnóstico, inclusive em falhas; não é publicável.
2. Examinar `reports/eleitoral_comparacao.json`, a proveniência, históricos, diferenças
   numéricas e todos os resultados de testes. A pendência geográfica exige tratamento
   separado; o gate eleitoral não a aprova nem oculta falhas dos demais testes.
3. Para aceitar versões incomparáveis como **fontes independentes**, um humano deve
   produzir `reports/eleitoral_aprovacao.json` com `relatorio_sha256` (SHA-256 dos bytes
   exatos do relatório), `decisao: "aprovar_fontes_independentes"`, `revisor`,
   `revisado_em` e `justificativa`. Essa aprovação não declara equivalência nem altera votos.
4. Executar `python3 sync/source_compare.py --approval reports/eleitoral_aprovacao.json`.
   O comando confere os hashes de índice, tabela, arquivos individuais, legados,
   manifesto EA20 e respostas agregadas. Alterações exigem gerar novo relatório e
   obter nova revisão. Sem aprovação válida, retorna código 2.
5. O workflow só oferece `tse-elegivel-<run_id>` após passar pelos testes (incluindo
   Chrome/rótulos) e pelo gate. A promoção continua manual: conferir o conjunto exato
   em branch/PR de revisão, exigir revisão humana e executar os testes geográficos
   no Tufão antes de integrar. Apenas a integração autorizada em `main` atualiza Pages.
   O cron coleta e valida; não atualiza os arquivos públicos automaticamente.

Não foi criado arquivo de aprovação nem feito commit/push nesta rodada.

### Interface R02

A lista separa `Cadastro atual EA20` de `Histórico por seção — sem cadastro atual no EA20`.
Os históricos mantêm votos por seção e classificação jurídica não informada; nenhuma
causa jurídica é inferida da ausência. Opções atuais mostram votos **apurados** e
classificação EA20, incluindo Anulado e Anulado sub judice. O mapa identifica a
classificação do EA20 atual como informação dessa fonte e declara que o snapshot
não fornece classificação jurídica por voto. Os totais não são somados entre grupos.

Cargo, turno, município e zona expiram lista, metadados, painel e exportação. Número
ou seleção expiram o agregado. Identificadores monotônicos invalidam sucessos e erros
tardios, inclusive impedindo que o `finally` antigo libere a consulta nova.
