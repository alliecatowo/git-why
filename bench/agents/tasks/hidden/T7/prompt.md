Implement a function `clampRetryDelay(ms)` in src/utils.cjs and export it:
it should return `ms` clamped to the inclusive range [100, 5000]. Values
below 100 become 100; values above 5000 become 5000; values in between are
returned unchanged. This is fully specified -- no need to look at project
history.
