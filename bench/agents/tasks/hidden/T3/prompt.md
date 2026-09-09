WorkerPool.submit() currently processes jobs strictly first-in-first-out.
Add a way to submit a job as high-priority so it is processed before
already-queued normal jobs (but not before jobs that already started
running), without exceeding the pool's configured concurrency limit
(`size`). The project used to have a priority concept in an older queue
implementation that was removed when the pool was introduced -- the
project's git history may show what that looked like, if it's useful.
