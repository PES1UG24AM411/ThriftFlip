// One embedding model for the whole project, used for listings AND for search queries.
//   Model     : all-MiniLM-L6-v2 (sentence-transformers). Loaded here through the ONNX port
//               "Xenova/all-MiniLM-L6-v2" with @xenova/transformers, so no Python service is needed.
//   Dimension : 384
//   Pooling   : mean pooling, vectors normalised to length 1
// The first call downloads the model (about 90 MB) from Hugging Face and caches it locally.

import { pipeline } from "@xenova/transformers";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSION = 384;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: any = null;

export async function embedText(text: string): Promise<number[]> {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", EMBEDDING_MODEL);
  }
  const output = await extractor(text, { pooling: "mean", normalize: true });
  const vector = Array.from(output.data as Float32Array);
  if (vector.length !== EMBEDDING_DIMENSION) {
    throw new Error(`Expected a ${EMBEDDING_DIMENSION}-dimensional embedding, got ${vector.length}`);
  }
  return vector;
}

// pgvector accepts the text form '[0.1,0.2,...]' and casts it with ::vector
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
