(function (root) {
  'use strict';
  /** Compara totais apenas quando todos os eixos eleitorais estão confirmados.
   * @param {Object} a Fonte com contexto e total nominal.
   * @param {Object} b Outra fonte com o mesmo contrato.
   * @returns {Object} Comparabilidade, estado, diferença e autorização de promoção.
   * @throws {Error} Total presente que não seja inteiro seguro não negativo.
   */
  function compare(a, b) {
    const keys = ['eleicaoId', 'turno', 'cargoId', 'uf', 'municipio', 'zona', 'categoria', 'classificacao', 'andamento', 'totalizacaoFinal', 'atualizado'];
    for (const source of [a, b]) {
      if (source.total != null && (!Number.isSafeInteger(source.total) || source.total < 0)) throw new Error('Total inválido na comparação');
    }
    const missing = keys.filter(k => a[k] == null || b[k] == null);
    const different = keys.filter(k => (a[k] ?? null) !== (b[k] ?? null));
    const delta = a.total != null && b.total != null ? a.total - b.total : null;
    const comparable = !missing.length && !different.length && delta !== null;
    const state = comparable ? (delta === 0 ? 'coincidente' : 'divergencia_bloqueante') : 'revisao_obrigatoria';
    return { comparavel: comparable, diferenca: delta, estado: state, publicar: state === 'coincidente',
      motivo: { ausentes: missing, diferentes: different } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { compare };
  else root.SourceCompare = { compare };
})(typeof window !== 'undefined' ? window : globalThis);
