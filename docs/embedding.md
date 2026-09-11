# The embedding model

`git why` ships a **static** embedding model: `potion-code-16M-v2`. There is no
transformer forward pass — tokenize, look up a vector per token, mean-pool,
normalise. That is the entire model, and it is why installing takes seconds,
indexing a 30,000-commit repository takes under a minute, and the only runtime
dependency is `@zvec/zvec`.

It is also the thing holding retrieval back, and by how much is measured.

## What the alternatives are worth

Pure vector retrieval over a fixed 12,101-document pool — no full-text branch,
no RRF, no reranking — because the question is what the embedding alone can do.
Same pool, same questions, same gold commits for every model. Regenerate with
`mise bench:embedders`.

<!-- generated:embedder-table -->

| model                            | kind        | Hit@1 | Hit@5 |      R@50 |       MRR |     per doc |
| -------------------------------- | ----------- | ----: | ----: | --------: | --------: | ----------: |
| jina-v2-base-en                  | transformer | 0.402 | 0.592 | **0.862** | **0.500** |      296 ms |
| jina-embeddings-v2-small-en      | transformer | 0.333 | 0.540 |     0.799 |     0.431 |       44 ms |
| bge-base-en-v1.5                 | transformer | 0.287 | 0.489 |     0.724 |     0.382 |      165 ms |
| jina-v2-small-q8                 | transformer | 0.236 | 0.431 |     0.701 |     0.325 |       25 ms |
| all-MiniLM-L6-v2                 | transformer | 0.207 | 0.454 |     0.741 |     0.324 |       29 ms |
| potion-base-32M                  | static      | 0.224 | 0.397 |     0.724 |     0.309 |     0.47 ms |
| **potion-code-16M-v2** (shipped) | static      | 0.195 | 0.408 |     0.753 |     0.305 |     0.23 ms |
| bge-small-en-v1.5                | transformer | 0.201 | 0.443 |     0.718 |     0.305 |       51 ms |
| potion-base-8M                   | static      | 0.195 | 0.379 |     0.672 |     0.284 | **0.21 ms** |
| potion-retrieval-32M             | static      | 0.126 | 0.282 |     0.644 |     0.209 |     0.44 ms |

<!-- /generated:embedder-table -->

Absolute scores are **easier** than the product's on full history, because the
pool is smaller. Only the comparison between rows is meaningful.

Three things worth knowing:

- **It is not a size story.** `bge-small` ties the shipped static model exactly
  at 0.305 while doing 200x the work, and `jina-v2-small` beats `bge-base` at a
  quarter of the parameters. Training objective decides this, not capacity.
- **`potion-retrieval-32M` is the worst of the ten**, despite being the one
  whose name promises this exact use case. That reproduces, from a different
  direction, the measurement that got it rejected earlier.
- **Quantisation is not the escape hatch.** int8 Jina is only 1.8x faster and
  gives up 25% of the MRR, landing it below the fp32 model it was meant to
  approximate.

## The trade, and why the default did not change

The cost is entirely in **indexing**, not querying.

|                                       | potion (default) | jina-v2-small |   jina-v2-base |
| ------------------------------------- | ---------------: | ------------: | -------------: |
| MRR                                   |            0.305 |  0.431 (+41%) |   0.500 (+64%) |
| per document                          |          0.23 ms |  44 ms (191x) | 296 ms (1287x) |
| first index, curl (182,772 records)   |             42 s |        ~2.2 h |          ~15 h |
| first index, ripgrep (12,865 records) |              3 s |        ~9 min |           ~1 h |
| **per query**                         |           0.2 ms |         44 ms |         296 ms |

A query pays one embedding either way, and 44 ms is nothing beside the ~290 ms
a query already takes. What changes is the one-time index build — and an ONNX
runtime, which is a real dependency with a real download.

So the default stays. A tool whose selling point is that it works offline,
installs in seconds and indexes in under a minute should not quietly become one
that needs an hour and a hundred megabytes.

## Using it anyway

```sh
npm install -g @huggingface/transformers      # the optional runtime
GIT_WHY_EMBEDDING=jina-v2-small git why index # rebuild the index with it
GIT_WHY_EMBEDDING=jina-v2-base  git why index # the ceiling, far slower
```

Pick by repository rather than by preference. Fifteen hours is absurd for curl
and unremarkable for a 2,000-commit service you will query for a year — and on
a repository that small, `jina-v2-base` is about an hour for the best retrieval
measured here.

`jina-v2-small` is the better choice if you are picking one: it captures two
thirds of the available gain for a seventh of the cost.

Three things the implementation guarantees:

- **Nothing changes for anyone who does not ask.** The candidate reports itself
  unavailable when the runtime is absent, and the default path never resolves
  it.
- **It fails loudly rather than falling back.** Asking for an uninstalled model
  is an error naming the install command. Silently using the default would make
  a benchmark report potion's numbers under Jina's name, which is worse than
  any error.
- **The index fingerprint encodes the model, pooling, normalisation and
  dimension.** An index built one way cannot be queried another and quietly
  return nonsense; it is detected instead.

`git why status` reports which model an index was built with.
