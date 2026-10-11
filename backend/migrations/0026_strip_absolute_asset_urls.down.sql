-- No-op: the up migration is a lossy normalisation (the original host
-- prefix isn't preserved anywhere), so there's nothing meaningful to
-- restore on a downgrade. Leaving the migration reversible in the
-- ledger without data manipulation.
SELECT 1;
