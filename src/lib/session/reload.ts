type Preparation = () => Promise<void>;

const preparations = new Set<Preparation>();

/** Release native listeners which otherwise outlive a document navigation. */
export function beforeWindowReload(prepare: Preparation): () => void {
  preparations.add(prepare);
  return () => {
    preparations.delete(prepare);
  };
}

export async function prepareWindowReload(): Promise<void> {
  await Promise.all([...preparations].map((prepare) => prepare()));
}
