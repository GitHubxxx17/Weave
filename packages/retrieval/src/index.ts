export type * from './types.js';
export { chunkDocument, prepareDocuments, retrievalVersions } from './chunking.js';
export { retrievalChunkId, retrievalManifestDigest } from './identity.js';
export { buildLexicalMatch, buildLexicalTerms } from './lexical-query.js';
export { diversifyRetrievalCandidates, fuseRetrievalCandidates } from './rrf.js';

export { createSqliteRetrievalIndex } from './sqlite-store.js';
export { RetrievalStoreError, RetrievalStoreStartupError } from './errors.js';
